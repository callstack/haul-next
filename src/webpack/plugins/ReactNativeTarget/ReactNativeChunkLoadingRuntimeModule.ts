// @ts-ignore
import compileBooleanMatcher from 'webpack/lib/util/compileBooleanMatcher';
import {
  getEntryInfo,
  needEntryDeferringCode,
  // @ts-ignore
} from 'webpack/lib/web/JsonpHelpers';
import webpack from 'webpack';
import { SyncWaterfallHook } from 'tapable';
// @ts-ignore
import JavascriptHotModuleReplacementRuntime from 'webpack/lib/hmr/JavascriptHotModuleReplacement.runtime.js';

const chunkHasJs = webpack.javascript.JavascriptModulesPlugin.chunkHasJs;
const Template = webpack.Template;

const compilationHooksMap = new WeakMap();

export class ReactNativeChunkLoadingRuntimeModule extends webpack.RuntimeModule {
  static getCompilationHooks(compilation: webpack.Compilation) {
    if (!(compilation instanceof webpack.Compilation)) {
      throw new TypeError(
        "The 'compilation' argument must be an instance of Compilation"
      );
    }
    let hooks = compilationHooksMap.get(compilation);
    if (hooks === undefined) {
      hooks = {
        linkPreload: new SyncWaterfallHook(['source', 'chunk'] as any),
        linkPrefetch: new SyncWaterfallHook(['source', 'chunk'] as any),
      };
      compilationHooksMap.set(compilation, hooks);
    }
    return hooks;
  }

  constructor(private runtimeRequirements: Set<string>) {
    super('React Native chunk loading', webpack.RuntimeModule.STAGE_ATTACH);
  }

  generate() {
    const { compilation, chunk } = this;
    const {
      runtimeTemplate,
      chunkGraph,
      outputOptions: {
        globalObject,
        chunkLoadingGlobal,
        hotUpdateGlobal,
        crossOriginLoading,
        scriptType,
      },
    } = compilation;
    const {
      linkPreload,
      linkPrefetch,
    } = ReactNativeChunkLoadingRuntimeModule.getCompilationHooks(compilation);

    if (!chunkGraph) {
      throw new Error('Chunk graph cannot be empty');
    }

    const fn = webpack.RuntimeGlobals.ensureChunkHandlers;
    const withLoading = this.runtimeRequirements.has(
      webpack.RuntimeGlobals.ensureChunkHandlers
    );
    const withDefer = needEntryDeferringCode(compilation, chunk);
    const withHmr = this.runtimeRequirements.has(
      webpack.RuntimeGlobals.hmrDownloadUpdateHandlers
    );
    const withHmrManifest = this.runtimeRequirements.has(
      webpack.RuntimeGlobals.hmrDownloadManifest
    );
    const withPrefetch = this.runtimeRequirements.has(
      webpack.RuntimeGlobals.prefetchChunkHandlers
    );
    const withPreload = this.runtimeRequirements.has(
      webpack.RuntimeGlobals.preloadChunkHandlers
    );
    const entries: Array<string | number> = getEntryInfo(
      chunkGraph,
      chunk,
      (c: webpack.Chunk) => chunkHasJs(c, chunkGraph)
    );
    const chunkLoadingGlobalExpr = `${globalObject}[${JSON.stringify(
      chunkLoadingGlobal
    )}]`;
    const hasJsMatcher = compileBooleanMatcher(
      chunkGraph.getChunkConditionMap(chunk, chunkHasJs)
    );
    return Template.asString([
      `${webpack.RuntimeGlobals.loadScript} = function() {`,
      Template.indent(
        "throw new Error('Missing implementation for __webpack_require__.l');"
      ),
      '};',
      '',
      '// object to store loaded and loading chunks',
      '// undefined = chunk not loaded, null = chunk preloaded/prefetched',
      '// Promise = chunk loading, 0 = chunk loaded',
      'var installedChunks = {',
      Template.indent(
        chunk.ids?.map((id) => `${JSON.stringify(id)}: 0`).join(',\n') ?? ''
      ),
      '};',
      '',
      withDefer
        ? Template.asString([
            'var deferredModules = [',
            Template.indent(entries.map((e) => JSON.stringify(e)).join(',\n')),
            '];',
          ])
        : '',
      withLoading
        ? Template.asString([
            `${fn}.rnl = ${runtimeTemplate.basicFunction(
              'chunkId, promises',
              hasJsMatcher !== false
                ? Template.indent([
                    '// React Native chunk loading for javascript',
                    `var installedChunkData = ${webpack.RuntimeGlobals.hasOwnProperty}(installedChunks, chunkId) ? installedChunks[chunkId] : undefined;`,
                    'if(installedChunkData !== 0) { // 0 means "already installed".',
                    Template.indent([
                      '',
                      '// a Promise means "currently loading".',
                      'if(installedChunkData) {',
                      Template.indent([
                        'promises.push(installedChunkData[2]);',
                      ]),
                      '} else {',
                      Template.indent([
                        hasJsMatcher === true
                          ? 'if(true) { // all chunks have JS'
                          : `if(${hasJsMatcher('chunkId')}) {`,
                        Template.indent([
                          '// setup Promise in chunk cache',
                          `var promise = new Promise(${runtimeTemplate.basicFunction(
                            'resolve, reject',
                            [
                              `installedChunkData = installedChunks[chunkId] = [resolve, reject];`,
                            ]
                          )});`,
                          'promises.push(installedChunkData[2] = promise);',
                          '',
                          '// start chunk loading',
                          `var url = ${webpack.RuntimeGlobals.getChunkScriptFilename}(chunkId);`,
                          '// create error before stack unwound to get useful stacktrace later',
                          'var error = new Error();',
                          `var loadingEnded = ${runtimeTemplate.basicFunction(
                            'event',
                            [
                              `if(${webpack.RuntimeGlobals.hasOwnProperty}(installedChunks, chunkId)) {`,
                              Template.indent([
                                'installedChunkData = installedChunks[chunkId];',
                                'if(installedChunkData !== 0) installedChunks[chunkId] = undefined;',
                                'if(installedChunkData) {',
                                Template.indent([
                                  "var errorType = event && (event.type === 'load' ? 'missing' : event.type);",
                                  'var realSrc = event && event.target && event.target.src;',
                                  "error.message = 'Loading chunk ' + chunkId + ' failed.\\n(' + errorType + ': ' + realSrc + ')';",
                                  "error.name = 'ChunkLoadError';",
                                  'error.type = errorType;',
                                  'error.request = realSrc;',
                                  'installedChunkData[1](error);',
                                ]),
                                '}',
                              ]),
                              '}',
                            ]
                          )};`,
                          `${webpack.RuntimeGlobals.loadScript}(url, loadingEnded, "chunk-" + chunkId, chunkId);`,
                        ]),
                        '} else installedChunks[chunkId] = 0;',
                      ]),
                      '}',
                    ]),
                    '}',
                  ])
                : Template.indent(['installedChunks[chunkId] = 0;'])
            )};`,
          ])
        : '// no chunk on demand loading',
      '',
      // TODO: figure out when this applies
      withPrefetch && hasJsMatcher !== false
        ? `${
            webpack.RuntimeGlobals.prefetchChunkHandlers
          }.j = ${runtimeTemplate.basicFunction('chunkId', [
            `if((!${
              webpack.RuntimeGlobals.hasOwnProperty
            }(installedChunks, chunkId) || installedChunks[chunkId] === undefined) && ${
              hasJsMatcher === true ? 'true' : hasJsMatcher('chunkId')
            }) {`,
            Template.indent([
              'installedChunks[chunkId] = null;',
              linkPrefetch.call(
                Template.asString([
                  "var link = document.createElement('link');",
                  crossOriginLoading
                    ? `link.crossOrigin = ${JSON.stringify(
                        crossOriginLoading
                      )};`
                    : '',
                  `if (${webpack.RuntimeGlobals.scriptNonce}) {`,
                  Template.indent(
                    `link.setAttribute("nonce", ${webpack.RuntimeGlobals.scriptNonce});`
                  ),
                  '}',
                  'link.rel = "prefetch";',
                  'link.as = "script";',
                  `link.href = ${webpack.RuntimeGlobals.publicPath} + ${webpack.RuntimeGlobals.getChunkScriptFilename}(chunkId);`,
                ]),
                chunk
              ),
              'document.head.appendChild(link);',
            ]),
            '}',
          ])};`
        : '// no prefetching',
      '',
      // TODO: figure out when this applies
      withPreload && hasJsMatcher !== false
        ? `${
            webpack.RuntimeGlobals.preloadChunkHandlers
          }.j = ${runtimeTemplate.basicFunction('chunkId', [
            `if((!${
              webpack.RuntimeGlobals.hasOwnProperty
            }(installedChunks, chunkId) || installedChunks[chunkId] === undefined) && ${
              hasJsMatcher === true ? 'true' : hasJsMatcher('chunkId')
            }) {`,
            Template.indent([
              'installedChunks[chunkId] = null;',
              linkPreload.call(
                Template.asString([
                  "var link = document.createElement('link');",
                  scriptType
                    ? `link.type = ${JSON.stringify(scriptType)};`
                    : '',
                  "link.charset = 'utf-8';",
                  `if (${webpack.RuntimeGlobals.scriptNonce}) {`,
                  Template.indent(
                    `link.setAttribute("nonce", ${webpack.RuntimeGlobals.scriptNonce});`
                  ),
                  '}',
                  'link.rel = "preload";',
                  'link.as = "script";',
                  `link.href = ${webpack.RuntimeGlobals.publicPath} + ${webpack.RuntimeGlobals.getChunkScriptFilename}(chunkId);`,
                  crossOriginLoading
                    ? Template.asString([
                        "if (link.href.indexOf(window.location.origin + '/') !== 0) {",
                        Template.indent(
                          `link.crossOrigin = ${JSON.stringify(
                            crossOriginLoading
                          )};`
                        ),
                        '}',
                      ])
                    : '',
                ]),
                chunk
              ),
              'document.head.appendChild(link);',
            ]),
            '}',
          ])};`
        : '// no preloaded',
      '',
      withHmr
        ? Template.asString([
            'var currentUpdatedModulesList;',
            'var waitingUpdateResolves = {};',
            'function loadUpdateChunk(chunkId) {',
            Template.indent([
              `return new Promise(${runtimeTemplate.basicFunction(
                'resolve, reject',
                [
                  'waitingUpdateResolves[chunkId] = resolve;',
                  '// start update chunk loading',
                  `var url = ${webpack.RuntimeGlobals.publicPath} + ${webpack.RuntimeGlobals.getChunkUpdateScriptFilename}(chunkId);`,
                  '// create error before stack unwound to get useful stacktrace later',
                  'var error = new Error();',
                  `var loadingEnded = ${runtimeTemplate.basicFunction('event', [
                    'if(waitingUpdateResolves[chunkId]) {',
                    Template.indent([
                      'waitingUpdateResolves[chunkId] = undefined',
                      "var errorType = event && (event.type === 'load' ? 'missing' : event.type);",
                      'var realSrc = event && event.target && event.target.src;',
                      "error.message = 'Loading hot update chunk ' + chunkId + ' failed.\\n(' + errorType + ': ' + realSrc + ')';",
                      "error.name = 'ChunkLoadError';",
                      'error.type = errorType;',
                      'error.request = realSrc;',
                      'reject(error);',
                    ]),
                    '}',
                  ])};`,
                  `${webpack.RuntimeGlobals.loadScript}(url, loadingEnded);`,
                ]
              )});`,
            ]),
            '}',
            '',
            `${globalObject}[${JSON.stringify(
              hotUpdateGlobal
            )}] = ${runtimeTemplate.basicFunction(
              'chunkId, moreModules, runtime',
              [
                'for(var moduleId in moreModules) {',
                Template.indent([
                  `if(${webpack.RuntimeGlobals.hasOwnProperty}(moreModules, moduleId)) {`,
                  Template.indent([
                    'currentUpdate[moduleId] = moreModules[moduleId];',
                    'if(currentUpdatedModulesList) currentUpdatedModulesList.push(moduleId);',
                  ]),
                  '}',
                ]),
                '}',
                'if(runtime) currentUpdateRuntime.push(runtime);',
                'if(waitingUpdateResolves[chunkId]) {',
                Template.indent([
                  'waitingUpdateResolves[chunkId]();',
                  'waitingUpdateResolves[chunkId] = undefined;',
                ]),
                '}',
              ]
            )};`,
            '',
            Template.getFunctionContent(JavascriptHotModuleReplacementRuntime)
              .replace(/\$key\$/g, 'jsonp')
              .replace(/\$installedChunks\$/g, 'installedChunks')
              .replace(/\$loadUpdateChunk\$/g, 'loadUpdateChunk')
              .replace(/\$moduleCache\$/g, webpack.RuntimeGlobals.moduleCache)
              .replace(
                /\$moduleFactories\$/g,
                webpack.RuntimeGlobals.moduleFactories
              )
              .replace(
                /\$ensureChunkHandlers\$/g,
                webpack.RuntimeGlobals.ensureChunkHandlers
              )
              .replace(
                /\$hasOwnProperty\$/g,
                webpack.RuntimeGlobals.hasOwnProperty
              )
              .replace(
                /\$hmrModuleData\$/g,
                webpack.RuntimeGlobals.hmrModuleData
              )
              .replace(
                /\$hmrDownloadUpdateHandlers\$/g,
                webpack.RuntimeGlobals.hmrDownloadUpdateHandlers
              )
              .replace(
                /\$hmrInvalidateModuleHandlers\$/g,
                webpack.RuntimeGlobals.hmrInvalidateModuleHandlers
              ),
          ])
        : '// no HMR',
      '',
      withHmrManifest
        ? Template.asString([
            `${
              webpack.RuntimeGlobals.hmrDownloadManifest
            } = ${runtimeTemplate.basicFunction('', [
              'if (typeof fetch === "undefined") throw new Error("No browser support: need fetch API");',
              `return fetch(${webpack.RuntimeGlobals.publicPath} + ${
                webpack.RuntimeGlobals.getUpdateManifestFilename
              }()).then(${runtimeTemplate.basicFunction('response', [
                'if(response.status === 404) return; // no update available',
                'if(!response.ok) throw new Error("Failed to fetch update manifest " + response.statusText);',
                'return response.json();',
              ])});`,
            ])};`,
          ])
        : '// no HMR manifest',
      '',
      withDefer
        ? Template.asString([
            `var checkDeferredModules = ${runtimeTemplate.emptyFunction()};`,
          ])
        : '// no deferred startup',
      '',
      withDefer || withLoading
        ? Template.asString([
            '// install a callback for chunk loading',
            `var webpackPushCallback = ${runtimeTemplate.basicFunction(
              'parentChunkLoadingFunction, data',
              [
                runtimeTemplate.destructureArray(
                  [
                    'chunkIds',
                    'moreModules',
                    'runtime',
                    ...(withDefer ? ['executeModules'] : []),
                  ],
                  'data'
                ),
                '// add "moreModules" to the modules object,',
                '// then flag all "chunkIds" as loaded and fire callback',
                'var moduleId, chunkId, i = 0, resolves = [];',
                'for(;i < chunkIds.length; i++) {',
                Template.indent([
                  'chunkId = chunkIds[i];',
                  `if(${webpack.RuntimeGlobals.hasOwnProperty}(installedChunks, chunkId) && installedChunks[chunkId]) {`,
                  Template.indent(
                    'resolves.push(installedChunks[chunkId][0]);'
                  ),
                  '}',
                  'installedChunks[chunkId] = 0;',
                ]),
                '}',
                'for(moduleId in moreModules) {',
                Template.indent([
                  `if(${webpack.RuntimeGlobals.hasOwnProperty}(moreModules, moduleId)) {`,
                  Template.indent(
                    `${webpack.RuntimeGlobals.moduleFactories}[moduleId] = moreModules[moduleId];`
                  ),
                  '}',
                ]),
                '}',
                'if(runtime) runtime(__webpack_require__);',
                'if(parentChunkLoadingFunction) parentChunkLoadingFunction(data);',
                'while(resolves.length) {',
                Template.indent('resolves.shift()();'),
                '}',
                withDefer
                  ? Template.asString([
                      '',
                      '// add entry modules from loaded chunk to deferred list',
                      'if(executeModules) deferredModules.push.apply(deferredModules, executeModules);',
                      '',
                      '// run deferred modules when all chunks ready',
                      'return checkDeferredModules();',
                    ])
                  : '',
              ]
            )}`,
            '',
            `var chunkLoadingGlobal = ${chunkLoadingGlobalExpr} = ${chunkLoadingGlobalExpr} || [];`,
            'chunkLoadingGlobal.forEach(webpackPushCallback.bind(null, 0));',
            'chunkLoadingGlobal.push = webpackPushCallback.bind(null, chunkLoadingGlobal.push.bind(chunkLoadingGlobal));',
          ])
        : '// no push function',
      '',
      withDefer
        ? Template.asString([
            'function checkDeferredModulesImpl() {',
            Template.indent([
              'var result;',
              'for(var i = 0; i < deferredModules.length; i++) {',
              Template.indent([
                'var deferredModule = deferredModules[i];',
                'var fulfilled = true;',
                'for(var j = 1; j < deferredModule.length; j++) {',
                Template.indent([
                  'var depId = deferredModule[j];',
                  'if(installedChunks[depId] !== 0) fulfilled = false;',
                ]),
                '}',
                'if(fulfilled) {',
                Template.indent([
                  'deferredModules.splice(i--, 1);',
                  'result = ' +
                    '__webpack_require__(' +
                    `${webpack.RuntimeGlobals.entryModuleId} = deferredModule[0]);`,
                ]),
                '}',
              ]),
              '}',
              'if(deferredModules.length === 0) {',
              Template.indent([
                `${webpack.RuntimeGlobals.startup}();`,
                `${
                  webpack.RuntimeGlobals.startup
                } = ${runtimeTemplate.emptyFunction()};`,
              ]),
              '}',
              'return result;',
            ]),
            '}',
            `var startup = ${webpack.RuntimeGlobals.startup};`,
            `${
              webpack.RuntimeGlobals.startup
            } = ${runtimeTemplate.basicFunction('', [
              '// reset startup function so it can be called again when more startup code is added',
              `${
                webpack.RuntimeGlobals.startup
              } = startup || (${runtimeTemplate.emptyFunction()});`,
              'return (checkDeferredModules = checkDeferredModulesImpl)();',
            ])};`,
          ])
        : '// no deferred startup',
    ]);
  }
}
