import { unicodeSearchKey } from "../localization/unicode";

/** Locale-independent Unicode casing with canonical equivalence for search. */
export function caselessKey(value: string): string {
    // An empty locale deliberately retains default (non-Turkic) case folding.
    return unicodeSearchKey(value, "");
}
