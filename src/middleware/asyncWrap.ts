import type { NextFunction, Request, Response, Router } from "express";

export type AnyHandler = (req: Request, res: Response, next: NextFunction) => any;

export function asyncHandler(fn: AnyHandler): AnyHandler {
  return function wrapped(req: Request, res: Response, next: NextFunction) {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

function wrapIfHandler(arg: any) {
  // Don't wrap error middleware: (err, req, res, next)
  if (typeof arg === "function" && arg.length !== 4) return asyncHandler(arg);
  return arg;
}

function patchMethods(target: any) {
  const methods = ["use", "all", "get", "post", "put", "patch", "delete", "head", "options"]; // common express methods
  for (const m of methods) {
    const orig = target[m];
    if (typeof orig !== "function") continue;
    if ((orig as any).__asyncWrapped) continue;

    const wrapped = (...args: any[]) => orig.call(target, ...args.map(wrapIfHandler));
    (wrapped as any).__asyncWrapped = true;
    target[m] = wrapped;
  }
}

export function patchAppForAsyncErrors(app: any) {
  patchMethods(app);
  return app;
}

export function patchRouterForAsyncErrors(router: any) {
  patchMethods(router);
  return router as Router;
}

export function createAsyncRouter(expressModule: { Router: () => Router }) {
  const router = expressModule.Router();
  return patchRouterForAsyncErrors(router);
}
