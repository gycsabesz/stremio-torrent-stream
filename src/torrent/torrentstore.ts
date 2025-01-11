import * as fs from 'fs/promises';
import path from "path";
import { Torrent } from "webtorrent";
import { getReadableDuration } from "../utils/file.js";
import { filterExpiredTorrents } from "./ncore.js";
import { getTorrents } from "./webtorrent.js";

// Directory to persist torrent files to continue upon next startup
const TORRENT_DIR = process.env.TORRENT_DIR;

// Whether the continue seeding of torrents are enabled
const ENABLED = !!TORRENT_DIR;

// Time (ms) to seed torrents after all streams are closed (default 1 minute)
const SEED_TIME = Number(process.env.SEED_TIME) || 60 * 1000;

const torrentPath = (torrent: Torrent) => path.join(TORRENT_DIR, torrent.infoHash + '.torrent')

const toArrayBuffer = (buffer: Buffer) => {
    const arrayBuffer = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; ++i) {
        view[i] = buffer[i];
    }
    return view;
}

export const add = async (torrent: Torrent) => {
    if (!ENABLED) return;

    const target = torrentPath(torrent);

    try {
        await fs.access(target)
    } catch {
        console.log('Add new torrent file into store: ' + target);

        await fs.writeFile(target, toArrayBuffer(torrent.torrentFile));

        await notifyAll('add', target);
    }
}

export const remove = async (torrent: Torrent | string) => {
    if (!ENABLED) return;

    if (typeof torrent !== 'string') {
        torrent = torrentPath(torrent);
    }

    console.log('Remove torrent file from store: ' + torrent);

    await notifyAll('remove', torrent);

    await fs.rm(torrent);
}

export const reloadExistings = async () => {
    if (!ENABLED) return;

    console.log('Looking for previously added torrents...');

    const savedTorrentFilePaths = await listTorrentFiles(TORRENT_DIR);
    console.log(`Continue ${savedTorrentFilePaths.length} torrents...`);

    for (const torrentFile of savedTorrentFilePaths) {
        await notifyAll('continue', torrentFile);
    }

    console.log('Torrent files reloaded successfully.');
}

const listTorrentFiles = async (directory) => {
    const files = await fs.readdir(directory, { withFileTypes: true });

    const torrentFiles = files
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.torrent'))
        .map((dirent) => path.join(directory, dirent.name));

    return torrentFiles;
}

setInterval(async () => {
    console.log(`Removing torrents added ${getReadableDuration(SEED_TIME)} ago...`)

    const existingTorrentFiles = await listTorrentFiles(TORRENT_DIR);
    const existingTorrentFilesWithMeta = await Promise.all(existingTorrentFiles.map(async (file) => {
        const { birthtime } = await fs.stat(file);
        const age = new Date().getTime() - birthtime.getTime();
        return { age, file };
    }));

    const expiredTorrents = await filterExpiredTorrents(getTorrents());
    console.log('Expired ncore torrents: ', expiredTorrents.map(t => t.name));

    const expiredTorrentFiles = existingTorrentFilesWithMeta
        .filter(({ age }) => age > SEED_TIME).map(({ file }) => file)
        .filter((fname) => expiredTorrents.some((t) => fname.includes(t.infoHash)));

    console.log(`Found ${expiredTorrentFiles.length} torrents old enough to remove.`);

    expiredTorrentFiles.forEach(remove);
}, 30 * 60 * 1000)

// Listener handling

type TEventListener = (torrentPath: string) => Promise<unknown>;

type TEvent = 'add' | 'remove' | 'continue';

const eventListeners = new Map<TEvent, TEventListener[]>();

export const on = (event: TEvent, listener: TEventListener) => {
    if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
    }

    eventListeners.get(event).push(listener);
}

const notifyAll = (event: TEvent, torrentPath: string) => {
    return Promise.all((eventListeners.get(event) || []).map(l => l(torrentPath)))
}