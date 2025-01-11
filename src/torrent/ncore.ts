import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { TorrentSearchResult } from "./search.js";
import { isImdbId } from "../utils/imdb.js";
import { createHash } from "crypto";
import parseTorrent from 'parse-torrent';
import { Torrent } from "webtorrent";

const NCORE_USER = process.env.NCORE_USER;
const NCORE_PASSWORD = process.env.NCORE_PASSWORD;

export enum NcoreCategory {
  Film_SD_HU = "xvid_hun",
  Film_SD_EN = "xvid",
  Film_HD_HU = "hd_hun",
  Film_HD_EN = "hd",
  Sorozat_SD_HU = "xvidser_hun",
  Sorozat_SD_EN = "xvidser",
  Sorozat_HD_HU = "hdser_hun",
  Sorozat_HD_EN = "hdser",
}

export const searchNcore = async (
  searchQuery: string,
  categories: NcoreCategory[],
  ncoreUser?: string,
  ncorePassword?: string
): Promise<TorrentSearchResult[]> => {
  try {
    const client = ncoreClientFactory(ncoreUser, ncorePassword);

    if (!client) return [];

    const torrents: TorrentSearchResult[] = [];

    let page = 0;

    while (page <= 5) {
      try {
        page++;

        let torrentsOnPage = 0;

        let params = new URLSearchParams({
          oldal: page.toString(),
          tipus: "kivalasztottak_kozott",
          kivalasztott_tipus: categories.join(","),
          mire: searchQuery,
          miben: isImdbId(searchQuery) ? "imdb" : "name",
          miszerint: "ctime",
          hogyan: "DESC",
        });

        const link = `/torrents.php?${params.toString()}}`;
        const torrentsPage = await client.get(link);
        const $ = cheerio.load(torrentsPage.data);

        const downloadKey = getDownloadKey($);
        if (!downloadKey) return torrents;

        for (const el of $("div.box_torrent")) {
          torrentsOnPage++;

          const name = $(el).find("div.torrent_txt > a").attr("title");

          const categoryHref = $(el)
            .find("a > img.categ_link")
            .parent()
            .attr("href");

          const tracker = "nCore";
          const category = parseCategory(categoryHref?.split("=")[1]);
          const size = parseSize($(el).find("div.box_meret2").text());
          const seeds = Number($(el).find("div.box_s2").text());
          const peers = Number($(el).find("div.box_l2").text());
          const torrentId = $(el).next().next().attr("id");
          const torrent = createTorrentUrl(torrentId, downloadKey);

          if (!name || !torrentId) continue;

          torrents.push({
            name,
            tracker,
            category,
            size,
            seeds,
            peers,
            torrent,
          });
        }

        if (torrentsOnPage < 50) break;
      } catch {
        continue;
      }
    }

    return torrents;
  } catch (error) {
    return [];
  }
};

const getDownloadKey = ($: cheerio.CheerioAPI) => {
  const rssUrl = $("link[rel=alternate]").attr("href");
  return rssUrl?.split("=")[1];
}

const createTorrentUrl = (torrentId: string, downloadKey: string) => `https://ncore.pro/torrents.php?action=download&id=${torrentId}&key=${downloadKey}`;

const parseCategory = (category: string | undefined) => {
  const categories: Record<NcoreCategory, string> = {
    [NcoreCategory.Film_SD_HU]: "Movies/SD/HU",
    [NcoreCategory.Film_SD_EN]: "Movies/SD/EN",
    [NcoreCategory.Film_HD_HU]: "Movies/HD/HU",
    [NcoreCategory.Film_HD_EN]: "Movies/HD/EN",
    [NcoreCategory.Sorozat_SD_HU]: "TV/SD/HU",
    [NcoreCategory.Sorozat_SD_EN]: "TV/SD/EN",
    [NcoreCategory.Sorozat_HD_HU]: "TV/HD/HU",
    [NcoreCategory.Sorozat_HD_EN]: "TV/HD/EN",
  };

  return categories[category as NcoreCategory];
};

const parseSize = (size: string) => {
  const units: Record<string, number> = {
    TiB: 1024 ** 4,
    GiB: 1024 ** 3,
    MiB: 1024 ** 2,
    KiB: 1024,
    B: 1,
  };

  const [sizeStr, unit] = size.split(" ");
  const sizeNum = Number(sizeStr);

  if (!sizeNum || !units[unit]) return 0;

  return Math.ceil(sizeNum * units[unit]);
};

const ncoreClients = new Map<string, AxiosInstance>();

export const ncoreClientFactory = (ncoreUser?: string, ncorePassword?: string) => {
  const user = ncoreUser || NCORE_USER;
  const password = ncorePassword || NCORE_PASSWORD;

  if (!user || !password) return undefined;

  const hash = createHash('md5').update(`${user}|${password}`).digest('hex');

  if (!ncoreClients.has(hash)) {
    const jar = new CookieJar();

    // @ts-ignore
    const client: AxiosInstance = wrapper(axios.create({ jar, baseURL: "https://ncore.pro" }));

    client.interceptors.response.use(async (response) => {
      const originalRequest = response.config;

      const loginRequested = originalRequest.url === '/login.php';

      if (!loginRequested) {
        if (response.request?.path?.includes('/login.php')) {
          console.log('Re authenticating nCore user...')

          const formData = new FormData();
          formData.append("nev", user);
          formData.append("pass", password);
          formData.append("set_lang", "hu");
          formData.append("submitted", "1");

          await client.post("/login.php", formData);

          return client(originalRequest);
        }
      }

      return response;
    });

    ncoreClients.set(hash, client);
  }

  return ncoreClients.get(hash);
}

export const filterExpiredTorrents = async (
  torrents: Torrent[],
  ncoreUser?: string,
  ncorePassword?: string
) => {
  const client = ncoreClientFactory(ncoreUser, ncorePassword);

  if (!client) return [];

  const hitnRunPage = await client.get('/hitnrun.php?showall=false')
  const $ = cheerio.load(hitnRunPage.data);
  const downloadKey = getDownloadKey($);
  const hitnRunTorrents = await Promise.all($('.hnr_torrents .hnr_tname a').toArray().map(async (a) => {
    const href = $(a).attr("href");
    const url = new URL(href, 'https://ncore.pro');
    const torrentId = url.searchParams.get('id');
    const torrentUrl = createTorrentUrl(torrentId, downloadKey);
    const torrentFile = await client.get(torrentUrl, {
      responseType: 'arraybuffer',
    });
    return parseTorrent(torrentFile.data);
  }));

  return torrents.filter((t) => !hitnRunTorrents.some((hnrt) => hnrt.infoHash === t.infoHash))
}
