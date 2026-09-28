import type { HyperDeckRest } from '../hyperdeck/rest.js';

/**
 * The deck's own NAS bookmarks (Ethernet protocol `nas add`/`nas remove`/
 * `nas select`/`nas discovered`/`nas selected`, or equivalently the REST API's
 * /media/nas/... endpoints, used here). A "bookmark" is a saved SMB share
 * URL with optional credentials; "selected" is the one the deck currently
 * records/plays to. Only one can be selected at a time.
 *
 * Field names and endpoints are from Blackmagic's published REST API for
 * HyperDeck (Developer Information PDF) — not yet checked against real
 * hardware, so surface the deck's own error text on failure rather than
 * assuming a shape that doesn't match a given firmware version.
 */
export interface NasBookmark {
  url: string;
}

export interface NasHost {
  hostName: string;
  friendlyName?: string;
  ip: string;
}

export async function listBookmarks(rest: HyperDeckRest): Promise<NasBookmark[]> {
  const r = await rest.get<{ bookmarks?: NasBookmark[] }>('/media/nas/bookmarks');
  return r.bookmarks ?? [];
}

export async function addBookmark(rest: HyperDeckRest, url: string, username?: string, password?: string): Promise<void> {
  await rest.send('POST', '/media/nas/bookmarks', bookmarkBody(url, username, password));
}

/** Same shape as add — the deck's PUT on a bookmark URL creates it if missing, or updates its credentials. */
export async function setBookmarkCredentials(rest: HyperDeckRest, url: string, username?: string, password?: string): Promise<void> {
  await rest.send('PUT', `/media/nas/bookmarks/${encodeBookmarkUrl(url)}`, credentialsBody(username, password));
}

export async function removeBookmark(rest: HyperDeckRest, url: string): Promise<void> {
  await rest.send('DELETE', `/media/nas/bookmarks/${encodeBookmarkUrl(url)}`);
}

export async function getSelected(rest: HyperDeckRest): Promise<string | null> {
  const r = await rest.get<{ selected: { url: string } | null }>('/media/nas/selected');
  return r.selected?.url ?? null;
}

/** Mount (or with `url: null`, unmount) a bookmarked share as the deck's active network storage. */
export async function select(rest: HyperDeckRest, url: string | null): Promise<void> {
  await rest.send('PUT', '/media/nas/selected', { selected: url ? { url } : null });
}

export async function discover(rest: HyperDeckRest): Promise<NasHost[]> {
  const r = await rest.get<{ hosts?: NasHost[] }>('/media/nas/discovered');
  return r.hosts ?? [];
}

function bookmarkBody(url: string, username?: string, password?: string) {
  return { url, ...credentialsBody(username, password) };
}

function credentialsBody(username?: string, password?: string) {
  const body: Record<string, string> = {};
  if (username) body.username = username;
  if (password) body.password = password;
  return body;
}

/** "Slashes in url should be encoded as %2F" per the REST API docs — encodeURIComponent already does this. */
function encodeBookmarkUrl(url: string): string {
  return encodeURIComponent(url);
}
