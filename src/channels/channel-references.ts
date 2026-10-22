/** Pure channel reference codec. Numeric IDs are a renderer/storage import boundary. */
interface ChannelReference {
    ambiguous?: boolean;
    itemId?: string;
    legacyId?: number | string;
    origin?: "raw" | "canonical";
}
function createChannelReferences(channels: any, aliases?: any) {
    var numbers: Record<string, string> = Object.create(null);
    var items: Record<string, number | null> = Object.create(null);
    var edges: Record<string, string[]> = Object.create(null);
    var uncertain: Record<string, boolean> = Object.create(null);
    function owns(object: any, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(object, key);
    }
    function numberKey(value: any): string | null {
        if (
            (typeof value !== "number" && typeof value !== "string") ||
            !/^-?\d+$/.test(String(value))
        )
            return null;
        var number = Number(value);
        return isFinite(number) ? String(number) : null;
    }
    function edge(previous: any, next: any): void {
        var key = numberKey(previous),
            target = numberKey(next);
        if (key === null) return;
        if (target === null) {
            uncertain[key] = true;
            return;
        }
        if (!edges[key]) edges[key] = [];
        if (edges[key].indexOf(target) < 0) edges[key].push(target);
    }
    Object.keys(channels || {}).forEach(function (key) {
        var row = channels[key],
            number = numberKey(key);
        if (!row || number === null) return;
        var item = String(row.itemId || "channel:" + number);
        numbers[number] = item;
        items[item] =
            !owns(items, item) || items[item] === Number(number)
                ? Number(number)
                : null;
        if (row.legacyChannelId !== undefined)
            edge(row.legacyChannelId, number);
    });
    Object.keys(aliases || {}).forEach(function (key) {
        edge(key, aliases[key]);
    });
    function resolve(
        value: number | string,
        origin: "raw" | "canonical"
    ): ChannelReference {
        var key = numberKey(value);
        var pending: ChannelReference = { legacyId: value, origin: origin };
        if (key === null) return pending;
        if (origin === "canonical")
            return owns(numbers, key) ? { itemId: numbers[key] } : pending;
        var candidates: Record<string, boolean> = Object.create(null);
        var visited: Record<string, number> = Object.create(null);
        var ambiguous = false;
        function visit(at: string): void {
            if (visited[at] === 1) {
                ambiguous = true;
                return;
            }
            if (visited[at] === 2) return;
            visited[at] = 1;
            if (owns(numbers, at)) candidates[numbers[at]] = true;
            if (uncertain[at]) ambiguous = true;
            (edges[at] || []).forEach(function (next) {
                // Recording an unchanged hash is an identity edge, not a competing channel.
                if (next === at) {
                    if (!owns(numbers, at)) ambiguous = true;
                } else visit(next);
            });
            visited[at] = 2;
        }
        visit(key);
        var found = Object.keys(candidates);
        if (found.length === 1 && !ambiguous) return { itemId: found[0] };
        if (found.length > 1 || ambiguous) pending.ambiguous = true;
        return pending;
    }
    return {
        project: function (reference: ChannelReference): number | null {
            return reference &&
                typeof reference.itemId === "string" &&
                owns(items, reference.itemId)
                ? items[reference.itemId]
                : null;
        },
        resolve: resolve,
    };
}
(window as any).__ottChannelReferences = { create: createChannelReferences };
