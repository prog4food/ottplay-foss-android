import assert from "node:assert/strict";
import vm from "node:vm";
import screenRuntime from "./helpers/screen-runtime.cjs";

const w: any = { console };
w.window = w;
vm.createContext(w);
screenRuntime(w);
const enter = (key: number) => key === 13;
w.listKeyHandler = enter;
assert.equal(w.listKeyHandlerFn, enter);
const escape = (key: number) => key === 27;
w.listKeyHandlerFn = escape;
assert.equal(w.listKeyHandler, escape);
const owner = w.__ottClassicScreenPort.commitList();
assert.equal(owner.model.handler, escape);
w.__ottClassicScreenPort.invalidate();
assert.equal(owner.active(), false);
console.log("PASS: actual ClassicScreenPort handler aliases and ownership");
