'use strict';
const Bundle = require('./bundle').Bundle;
const BundledSource = require('./bundled-source').BundledSource;
const CLIOptions = require('../cli-options').CLIOptions;
const LoaderPlugin = require('./loader-plugin').LoaderPlugin;
const Configuration = require('../configuration').Configuration;
const path = require('path');

exports.Bundler = class {
  constructor(project, packageAnalyzer) {
    this.project = project;
    this.packageAnalyzer = packageAnalyzer;
    this.bundles = [];
    this.items = [];
    this.itemLookup = {};
    this.environment = CLIOptions.getEnvironment();

    let defaultBuildOptions = {
      minify: 'stage & prod',
      sourcemaps: 'dev & stage',
      rev: false
    };

    this.buildOptions = new Configuration(project.build.options, defaultBuildOptions);
    this.loaderOptions = project.build.loader;

    this.loaderConfig = {
      baseUrl: project.paths.root,
      paths: ensurePathsRelativelyFromRoot(project.paths || {}),
      packages: [],
      stubModules: [],
      shim: {}
    };
    Object.assign(this.loaderConfig, this.project.build.loader.config);

    this.loaderOptions.plugins = (this.loaderOptions.plugins || []).map(x => {
      let plugin = new LoaderPlugin(this, x);

      if (plugin.stub && this.loaderConfig.stubModules.indexOf(plugin.name) === -1) {
        this.loaderConfig.stubModules.push(plugin.name);
      }

      return plugin;
    });
  }

  static create(project, packageAnalyzer) {
    let bundler = new exports.Bundler(project, packageAnalyzer);

    return Promise.all(
      project.build.bundles.map(x => Bundle.create(bundler, x).then(bundle => {
        bundler.addBundle(bundle);
      }))
    ).then(() => bundler);
  }

  itemIncludedInBuild(item) {
    if (typeof item === 'string' || !item.env) {
      return true;
    }

    let value = item.env;
    let parts = value.split('&').map(x => x.trim().toLowerCase());

    return parts.indexOf(this.environment) !== -1;
  }

  getItemByPath(p) {
    return this.itemLookup[normalizeKey(p)];
  }

  // cached traced to feedback to amodro-trace
  getTraced() {
    let traced = [];
    const stubModules = this.loaderConfig.stubModules;

    for (let key in this.itemLookup) {
      const item = this.itemLookup[key];
      if (!item.moduleId || !item.deps) continue;
      // don't put stubbed in cache
      if (stubModules.indexOf(item.moduleId) >= 0) continue;

      let traceItem = {id: item.moduleId, deps: item.deps};

      if (!item.requiresTransform) {
        traceItem.contents = item.contents;
      }

      traced.push(traceItem);
    }

    return traced;
  }

  addFile(file, inclusion) {
    let key =  normalizeKey(file.path);
    let found = this.itemLookup[key];

    if (!found) {
      found = new BundledSource(this, file);
      this.itemLookup[key] = found;
      this.items.push(found);
    }

    if (inclusion) {
      inclusion.addItem(found);
    } else {
      subsume(this.bundles, found);
    }

    return found;
  }

  updateFile(file, inclusion) {
    let found = this.itemLookup[normalizeKey(file.path)];

    if (found) {
      found.update(file);
    } else {
      this.addFile(file, inclusion);
    }
  }

  addBundle(bundle) {
    this.bundles.push(bundle);
  }

  configureDependency(dependency) {
    return analyzeDependency(this.packageAnalyzer, dependency).then(description => {
      let loaderConfig = description.loaderConfig;

      if (loaderConfig.main) {
        this.loaderConfig.packages.push({
          name: loaderConfig.name,
          location: loaderConfig.path,
          main: loaderConfig.main
        });
      } else {
        this.loaderConfig.paths[loaderConfig.name] = loaderConfig.path;
      }

      if (loaderConfig.deps || loaderConfig.exports) {
        let shim = this.loaderConfig.shim[loaderConfig.name] = {};

        if (loaderConfig.deps) {
          shim.deps = loaderConfig.deps;
        }

        if (loaderConfig.exports) {
          shim.exports = loaderConfig.exports;
        }
      }

      return description;
    })
    .catch(e => {
      console.log(`Unable to analyze ${(dependency.name || dependency)}`);
      console.log(e);
      throw e;
    });
  }

  build() {
    let index = -1;
    let items = this.bundles;

    function doTransform() {
      index++;

      if (index < items.length) {
        return items[index].transform().then(doTransform);
      }

      return Promise.resolve();
    }

    return doTransform()
      .then(() => {
        //Order the bundles so that the bundle containing the config is processed last.
        let configTargetBundleIndex = this.bundles.findIndex(x => x.config.name === this.loaderOptions.configTarget);
        this.bundles.splice(this.bundles.length, 0, this.bundles.splice(configTargetBundleIndex, 1)[0]);
      })
      .catch(e => {
        console.log('Failed to do transforms');
        console.log(e);
        throw e;
      });
  }

  write() {
    return Promise.all(this.bundles.map(x => x.write(this.project.build.targets[0])));
  }

  getAllDependencyLocations() {
    return this.bundles.reduce((a, b) => a.concat(b.getDependencyLocations()), []);
  }
};

function analyzeDependency(packageAnalyzer, dependency) {
  if (typeof dependency === 'string') {
    return packageAnalyzer.analyze(dependency);
  }

  return packageAnalyzer.reverseEngineer(dependency);
}

function subsume(bundles, item) {
  for (let i = 0, ii = bundles.length; i < ii; ++i) {
    if (bundles[i].trySubsume(item)) {
      return;
    }
  }
}

function normalizeKey(p) {
  return path.normalize(p);
}

function ensurePathsRelativelyFromRoot(p) {
  let keys = Object.keys(p);
  let original = JSON.stringify(p, null, 2);
  let warn = false;

  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    if (key !== 'root' && p[key].indexOf(p.root + '/') === 0) {
      warn = true;
      p[key] = p[key].slice(p.root.length + 1);
    }
  }

  if (warn) {
    console.log('Warning: paths in the "paths" object in aurelia.json must be relative from the root path. Change ');
    console.log(original);
    console.log('to: ');
    console.log(JSON.stringify(p, null, 2));
  }

  return p;
}
