import { registerPlugin, WebPlugin } from "@capacitor/core";

export interface XmltvSources {
    xmltv_url?: string;
    xmltv_urls?: string[];
}
export interface MobileXmltvEpgPlugin {
    getChannels(options: XmltvSources): Promise<{
        channels: Array<{
            id: string;
            name: string;
            names: string[];
            icon: string;
        }>;
    }>;
    getEpg(
        options: XmltvSources & {
            ch?: string;
            channel_id: string;
            hash: string;
            tvg_name?: string;
            time_shift_hours?: number;
            archive_hours?: number;
        }
    ): Promise<{ epg_data: any[] }>;
    prefetch(options?: XmltvSources): Promise<void>;
}

class MobileXmltvEpgWeb extends WebPlugin implements MobileXmltvEpgPlugin {
    async getEpg(): Promise<{ epg_data: any[] }> {
        return { epg_data: [] };
    }
    async getChannels(): Promise<{ channels: [] }> {
        return { channels: [] };
    }
    async prefetch(): Promise<void> {}
}

const MobileXmltvEpg = registerPlugin<MobileXmltvEpgPlugin>("MobileXmltvEpg", {
    web: () => new MobileXmltvEpgWeb(),
});

export { MobileXmltvEpg };
