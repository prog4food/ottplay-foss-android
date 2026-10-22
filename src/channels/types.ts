/**
 * Represents a single TV channel entry parsed from a provider playlist.
 *
 * @property ch_id    - Unique numeric channel identifier from the provider.
 * @property channel_name - Display name of the channel.
 * @property url      - Primary stream URL.
 * @property icon     - URL to the channel logo image.
 * @property rec      - Number of archive hours available (0 or undefined = no archive).
 * @property name     - Name of the currently-airing program.
 * @property time     - Start timestamp (Unix seconds) of the current program.
 * @property time_to  - End timestamp of the current program.
 * @property descr    - Description of the current program.
 * @property nextpr   - Array of upcoming EPG entries, or null if not loaded.
 * @property outdated - Whether the channel metadata is stale and needs refresh.
 * @property time_request - Timestamp of last EPG data fetch (cache expiry).
 * @property number   - Numeric display string for the channel (e.g. "001").
 * @property group    - Category/group label assigned by the playlist.
 * @property cmd      - Raw command line from M3U8 or similar playlist format.
 */
export interface Channel {
    ch_id: number;
    channel_name: string;
    cmd?: string; // raw command from playlist
    descr?: string; // current program description
    group?: string; // group/category name
    icon?: string;
    name?: string; // current program name
    nextpr?: EPGEntry[] | null;
    number?: string; // display number
    outdated?: boolean;
    rec?: number; // archive hours available
    time?: number; // current program start (unix timestamp)
    time_request?: number; // EPG cache expiry
    time_to?: number; // current program end
    url?: string;
}

/**
 * Electronic Program Guide entry describing one program on a channel.
 *
 * @property name   - Program title.
 * @property time   - Start timestamp (Unix seconds).
 * @property time_to - End timestamp (Unix seconds).
 * @property descr  - Program description / synopsis.
 * @property icon   - Optional URL to program artwork or thumbnail.
 */
export interface EPGEntry {
    descr: string;
    icon?: string;
    name: string;
    time: number;
    time_to: number;
}

/**
 * Record of a previously viewed channel, used for "previous channel" navigation.
 *
 * @property ci - Channel ID that was playing.
 * @property c  - Category index at the time of switch.
 * @property i  - Primary (channel) index at the time of switch.
 * @property e  - Program name that was airing at switch time (from _prog100).
 * @property t  - If non-zero, the archive timestamp (playType + playTime) when the user was watching archive.
 */
export interface PreviousChannel {
    c: number; // category index
    ci: number; // channel id
    e?: string; // program name at switch time
    i: number; // primary index
    t?: number; // archive timestamp if was playing archive
}

/**
 * Entry in the media (VOD) history or favorites list.
 *
 * @property ch_id   - Optional channel ID this media is associated with.
 * @property name    - Display title of the media item.
 * @property fav     - Favorites flag (1 = favorited).
 * @property current - Last known playback position in seconds (for resume).
 */
export interface MediaHistoryEntry {
    ch_id: number;
    current?: number; // playback position in seconds
    fav?: number;
    name: string;
}

/**
 * Describes a single aspect-ratio preset for the video element.
 *
 * @property name  - Human-readable label (e.g. "Contain", "Cover").
 * @property value - CSS `object-fit` value to apply.
 */
export interface AspectRatio {
    name: string;
    value: string; // CSS object-fit value
}

/**
 * Describes a single zoom preset.
 *
 * @property name  - Human-readable label.
 * @property value - Internal zoom value (interpreted by the renderer).
 */
export interface ZoomPreset {
    name: string;
    value: string;
}
