/** Optional ESM utility. Native proxy transports resolve presets in their own platform code. */
export const UA_PRESETS: Record<string, string> = {
    dune: "Mozilla/5.0 (Dune HD; DuneOS) AppleWebKit/537.36 (KHTML, like Gecko) DuneHD/1.0 Chrome/68.0.3440.106 Safari/537.36",
    mag: "Mozilla/5.0 (STB; Infomir MAG524) Maple 6.0 QtWebKit/3.0",
    tizen: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungTV/3.0 Chrome/76.0.3809.146 Safari/537.36",
    viera: "Mozilla/5.0 (Unknown; Linux; Viera/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36",
    webos: "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 LG Browser/9.00.00",
};

export function resolveUA(input?: string): string {
    if (!input) return "OTT-play-FOSS/1.0";
    const key = input.toLowerCase();
    return UA_PRESETS[key] ?? input;
}
