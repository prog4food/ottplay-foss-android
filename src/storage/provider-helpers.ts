// Provider-scoped storage aliases

import {
    providerDelItem,
    providerGetItem,
    providerHasItem,
    providerHasItemValue,
    providerSetItem,
} from "../storage";

/** @returns Provider-stored string value for `key`, or null. */
export function _providerGetItem(key: string): string | null {
    return providerGetItem(key);
}

/** @returns True if `key` exists in provider storage. */
export function _providerHasItem(key: string): boolean {
    return providerHasItem(key);
}

/** @returns True if `key` exists and has a non-empty value. */
export function _providerHasItemValue(key: string): boolean {
    return providerHasItemValue(key);
}

/** Write `val` to provider storage under `key`. */
export function _providerSetItem(key: string, val: string): void {
    providerSetItem(key, val);
}

/** Delete `key` from provider storage. */
export function _providerDelItem(key: string): void {
    providerDelItem(key);
}
