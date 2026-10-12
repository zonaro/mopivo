/**
 * Streaming/Web URL provider - user-added streaming/web wallpaper sources
 */
import {BaseProvider} from './base.js';

export class StreamingProvider extends BaseProvider {
    constructor() {
        super();
        this._items = new Map();
    }

    get id() { return 'streaming'; }
    get displayName() { return 'Streaming/Web'; }
    get requiresApiKey() { return false; }
    get websiteUrl() { return ''; }
    get keyHelpUrl() { return ''; }
    get supportsVideo() { return true; }
    static get supportsVideo() { return true; }

    addItem({id, name, url, type = 'webpage'}) {
        this._items.set(id, {
            id: id || String(Date.now()),
            name,
            url,
            type,
            previewUrl: '',
            fullUrl: url,
            resolution: '',
            source: 'Streaming/Web',
            sourceUrl: url,
        });
    }

    getItems() {
        return Array.from(this._items.values());
    }

    async search(params, session, settings) {
        const q = (params.q || '').toLowerCase();
        let items = this.getItems();
        if (q) {
            items = items.filter(it => (it.name || '').toLowerCase().includes(q) || (it.url || '').toLowerCase().includes(q));
        }
        const page = params.page || 1;
        const perPage = params.perPage || 24;
        const total = items.length;
        const lastPage = Math.max(1, Math.ceil(total / perPage));
        const slice = items.slice((page - 1) * perPage, page * perPage);
        return {items: slice, total, page, lastPage};
    }
}
