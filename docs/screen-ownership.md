# Screen ownership and classic UI boundary

The shipped bundle constructs `__ottScreenController`, `__ottInputRouter`,
`__ottClassicScreenPort` and `__ottMenuRegistry` before loading UI renderers.
They are private ES5 modules; their implementation bindings are not globals.

A screen owns a model, input callback and disposal scope. A list is replaced
when its rows or handler identity changes. Redrawing the same list retains its
owner. Dialogs, editors and pickers suspend their parent; closing a parent
revokes descendants. Saved callbacks and delayed detail/selection work cannot
act on a retired screen. Cleanup may synchronously replace a source or open a
new screen: the newer operation wins.

`keyHandler` normalizes device events and delegates to the input router. The
router dispatches semantic commands to the active owner. Hardware key maps are
unchanged. Numeric saved button bindings (0–21) remain a read-only import into
stable command IDs. Mouse, touch, remote and native-editor input use the same
routing boundary. The native editor retains the collect-value-before-restore
ordering required by settings transfer while protecting a replacement editor
from an older callback's teardown.

## Compatibility port

Existing renderer/provider callers still use `listArray`, `listDataArray`,
`selIndex`, list render/detail/key callbacks, modal callbacks and editor fields.
These are accessor projections owned by the single classic screen port.
They do not allocate a second list/input state in `index.ts` or `ui/index.ts`.
Provider UI codecs remain explicit compatibility callers; this does not claim
that every UI renderer or provider settings form has been rewritten.

- `commitList()` returns the list owner used by `showPage()`.
- `listOwner()` exposes `active()`, `foreground()`, `guard(fn)` and `own(cleanup)`.
- `onDispose(cleanup)` commits the current list and attaches cleanup.
- `invalidate()` revokes the stack on provider replacement or catalog reload.
- `savePanel()/restorePanel()` preserve nested renderer chrome and owner context.
- `setOwnedCallback(kind, fn)` publishes a guarded modal callback.
- `decorateOwnedCallback(kind, expected, wrapper)` updates an existing modal
  callback without replacing its owner. It returns a foreground-guarded callback,
  or `null` when the expected callback has already been replaced.

Settings drafts should attach cancellation after `showPage()`; a nested editor
must not cancel its parent draft. Media page work may attach to the list owner,
while its provider/domain lifetime remains separate. A VPortal quality picker
uses the optional fifth `showSelectBox` argument `preserveParent=true`; it hides
and suspends the media list instead of cancelling the resolution request.
Provider picker wrappers use `decorateOwnedCallback`: assigning a replacement
global callback would retire the picker that owns its completion closure.

## Menu records

The menu registry uses IDs such as `settings.open`, `archive.records` and
`video.aspect`. Availability and key shortcuts are record policies, independent
of translated labels and JavaScript function names. The old parallel provider
arrays are imported only at the compatibility boundary. Existing `sHideMenus`
function IDs are accepted alongside new stable IDs. Unknown provider additions
retain a provider-scoped compatibility position until their callers publish an
explicit menu model. No saved data is rewritten by this change.

## Verification

`test_screen_ownership.cjs` executes the actual ES5 modules and UI functions:
reentrant disposal, source replacement, nested scopes, native editor ownership,
late timers, detached models, menu capabilities and legacy settings imports.
The full bundle smoke starts without source modules injected, then verifies
publication, private scope and working input/dialog/menu ownership in modern
and legacy profiles. Existing PIN, editor, provider, Tizen, touch and browser
suites remain active. ES5 grammar checks cover the shipped application and
retained device scripts; these are not physical TV hardware tests.
