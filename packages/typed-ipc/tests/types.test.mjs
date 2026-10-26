import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { root } from './helpers.mjs'

test('public declarations enforce namespace, context, protocol, direction and cleanup types', () => {
  const filename = path.join(root, 'tests/ipc-typecheck.ts')
  const source = `
import { initIpcRouter, TypedIpcMain } from '@electron-browser/typed-ipc/main';
import * as library from '@electron-browser/typed-ipc/main';
import type { CreateIpcRouter, IpcMiddleware, IpcMiddlewareCall, IpcEventErrorHandler } from '@electron-browser/typed-ipc/main';
import { TypedIpcRenderer } from '@electron-browser/typed-ipc/renderer';
import type { Unsubscribe } from '@electron-browser/typed-ipc';

type Requests = {
  'app:version': () => string;
  'window:load': (id: number) => Promise<string>;
};
type ToMain = { 'app:notify': (id: string) => void };
type ToRenderer = { 'app:progress': (percent: number) => void };
const context = {
  getMainWindow: (): Electron.BrowserWindow | null => null,
  version: '1.0.0'
};
const middleware: IpcMiddleware<typeof context> = async (call, next) => {
  const typedCall: IpcMiddlewareCall<typeof context> = call;
  const channel: string = call.channel;
  const args: readonly unknown[] = call.args;
  const win: Electron.BrowserWindow | null = call.ctx.getMainWindow();
  void [typedCall, channel, args, win];
  if (call.kind === 'invoke') {
    const event: Electron.IpcMainInvokeEvent = call.event;
    void event;
    // @ts-expect-error Invoke events do not provide the one-way event reply method.
    call.event.reply('anything');
  } else {
    const event: Electron.IpcMainEvent = call.event;
    void event;
    call.event.reply('anything');
  }
  // @ts-expect-error Application dependencies remain readonly inside middleware.
  call.ctx.version = '2';
  // @ts-expect-error Middleware cannot replace the payload tuple.
  call.args = [];
  // @ts-expect-error Middleware cannot overwrite arguments.
  call.args[0] = 'different';
  // @ts-expect-error Payloads need narrowing before use in cross-channel middleware.
  call.args[0].toFixed();
  const result = await next();
  // @ts-expect-error A shared middleware cannot assume every request returns a string.
  const fixedResult: string = result;
  void fixedResult;
  return result;
};
const onError: IpcEventErrorHandler<typeof context> = async (error, call) => {
  const kind: 'event' = call.kind;
  const event: Electron.IpcMainEvent = call.event;
  const win: Electron.BrowserWindow | null = call.ctx.getMainWindow();
  void [kind, event, win];
  // @ts-expect-error Reported errors must be narrowed before accessing properties.
  error.message;
};
const createRouter = initIpcRouter<Requests, typeof context, ToMain>({
  context,
  middlewares: [middleware] as const,
  onError
});
const typedFactory: CreateIpcRouter<Requests, typeof context, ToMain> = createRouter;
void typedFactory;
const app = createRouter('app');
const window = createRouter('window');
app.use(middleware, async ({ ctx, channel }, next) => {
  ctx.getMainWindow(); channel.toUpperCase();
  return await next();
}).handle('app:version', () => '1');
// @ts-expect-error Middleware cannot substitute a result of an unrelated type.
app.use(async () => 123);
// @ts-expect-error Middleware must return the downstream result, or throw.
app.use(async (_call, next) => { await next(); });
// @ts-expect-error Middleware is a function.
app.use('invalid');
// @ts-expect-error Global middleware follows the same result-preserving contract.
initIpcRouter<Requests, typeof context>({ context, middlewares: [async () => 'fixed'] });
// @ts-expect-error Event reporters cannot return a replacement IPC response.
initIpcRouter<Requests, typeof context>({ context, onError: () => 123 });
app.handle('app:version', ({ ctx, event }) => {
  const win: Electron.BrowserWindow | null = ctx.getMainWindow();
  const invokeEvent: Electron.IpcMainInvokeEvent = event;
  void [win, invokeEvent];
  return ctx.version;
});
window.handleOnce('window:load', async (_call, id) => id.toFixed());
window.handle('window:load', (_call, id) => String(id));
app.on('app:notify', ({ ctx, event }, id) => {
  const mainEvent: Electron.IpcMainEvent = event;
  void mainEvent; void ctx.getMainWindow(); id.toUpperCase();
}).once('app:notify', (_call, id) => { id.toUpperCase(); });
const off: Unsubscribe = app.register();
const windowOff: Unsubscribe = window.register();
off();
windowOff();
declare const target: Electron.WebContents;
// @ts-expect-error Unknown namespace.
createRouter('missing');
// @ts-expect-error Context must be supplied during initialization.
initIpcRouter<Requests, typeof context>();
// @ts-expect-error The returned value is a plain factory, not a context builder.
createRouter.context(context);
// @ts-expect-error The manager registration entry has been removed.
new library.IpcRouterManager();
// @ts-expect-error The factory is only a function, without alternate registration methods.
createRouter.registerAll([app]);
// @ts-expect-error Register takes no target or manager.
app.register(new TypedIpcMain<Requests>());
// @ts-expect-error Cross-module request; provide a callback to isolate channel checking.
app.handle('window:load', () => '');
// @ts-expect-error Cross-module event.
window.on('app:notify', () => {});
// @ts-expect-error Incorrect result type.
app.handle('app:version', () => 123);
// @ts-expect-error Incorrect asynchronous result type.
app.handleOnce('app:version', async () => 123);
// @ts-expect-error Incorrect payload type.
window.handle('window:load', (_call, id: string) => id);
// @ts-expect-error Incorrect event payload type.
app.on('app:notify', (_call, id: number) => { void id; });
app.handle('app:version', ({ ctx }) => {
  // @ts-expect-error Context is inferred without an index signature.
  ctx.missingService();
  // @ts-expect-error Handlers cannot replace application dependencies.
  ctx.version = '2';
  return ctx.version;
});
const emptyContext = {};
const defaults = initIpcRouter<Requests, typeof emptyContext>({ context: emptyContext });
// @ts-expect-error Empty event map forbids arbitrary subscriptions.
defaults('app').on('app:notify', () => {});
// @ts-expect-error Empty outgoing event map forbids sends.
new TypedIpcMain<Requests>().send(target, 'app:progress', 1);
const eventsOnly = initIpcRouter<Record<never, never>, typeof emptyContext, { 'task:ready': () => void }>({ context: emptyContext });
eventsOnly('task').on('task:ready', () => {});
// @ts-expect-error Events cannot be used as requests.
eventsOnly('task').handle('task:ready', () => {});
// @ts-expect-error Context value must match its declared type.
initIpcRouter<Requests, typeof context>({ context: { version: 1 } });
const otherContext = { name: 'other' };
const otherFactory = initIpcRouter<Requests, typeof otherContext, ToMain>({ context: otherContext });
const otherRouter = otherFactory('app');
// @ts-expect-error Middleware dependencies must match the router's context.
otherRouter.use(middleware);
// @ts-expect-error Global middleware dependencies must match the factory's context.
initIpcRouter<Requests, typeof otherContext>({ context: otherContext, middlewares: [middleware] });
otherRouter.handle('app:version', ({ ctx }) => {
  // @ts-expect-error Factories retain their own context type.
  ctx.getMainWindow();
  return ctx.name;
});
const otherProtocolFactory = initIpcRouter<{ 'task:run': () => number }, typeof otherContext>({ context: otherContext });
const task = otherProtocolFactory('task').handle('task:run', () => 1);
task.register();

const main = new TypedIpcMain<Requests, ToMain, ToRenderer>();
const renderer = new TypedIpcRenderer<Requests, ToMain, ToRenderer>();
const result: Promise<string> = renderer.invoke('window:load', 1);
const mainOff: Unsubscribe = main.handle('app:version', () => '1');
const onceOff: Unsubscribe = main.handleOnce('window:load', (_event, id) => String(id));
const eventOff: Unsubscribe = main.on('app:notify', (_event, id) => { id.toUpperCase(); });
const rendererOff: Unsubscribe = renderer.on('app:progress', (percent) => { percent.toFixed(); });
void [result, mainOff, onceOff, eventOff, rendererOff];
renderer.send('app:notify', 'task');
main.send(target, 'app:progress', 50);
main.removeHandler('app:version');
main.off('app:notify', (_event, id) => { id.toUpperCase(); });
renderer.off('app:progress', (percent) => { percent.toFixed(); });
// @ts-expect-error Requests cannot be sent as events.
renderer.send('app:version');
// @ts-expect-error Events cannot be invoked.
renderer.invoke('app:notify', 'task');
// @ts-expect-error Missing request payload.
renderer.invoke('window:load');
// @ts-expect-error Incorrect payload.
renderer.send('app:notify', 1);
// @ts-expect-error Wrong event direction.
renderer.send('app:progress', 1);
// @ts-expect-error Wrong event direction.
renderer.on('app:notify', () => {});
// @ts-expect-error Wrong event direction.
main.on('app:progress', () => {});
// @ts-expect-error Wrong event direction.
main.send(target, 'app:notify', 'task');
// @ts-expect-error Incorrect push payload.
main.send(target, 'app:progress', '50');
// @ts-expect-error Page callbacks must not receive the Electron event.
renderer.on('app:progress', (_event: Electron.IpcRendererEvent, _percent: number) => {});
// @ts-expect-error Wrong request result type.
main.handleOnce('app:version', async () => 1);
// @ts-expect-error Only requests have handlers.
main.removeHandler('app:notify');
// @ts-expect-error No arbitrary event channels when event maps are omitted.
new TypedIpcRenderer<Requests>().send('anything');
`
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.deepEqual(parsed.errors, [])
  const options = { ...parsed.options, noEmit: true, rootDir: root, skipLibCheck: false }
  const host = ts.createCompilerHost(options)
  const originalRead = host.readFile.bind(host)
  host.readFile = (file) => (path.resolve(file) === filename ? source : originalRead(file))
  const program = ts.createProgram([filename], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n'
    })
  )
})
