import type { CommunityCatalog, CommunityReleaseItem } from "../shared/ipc";

type CommunityRepository = CommunityReleaseItem["repository"];

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

const REPOSITORIES: Array<{ name: CommunityRepository; owner: string }> = [
  { name: "Driftleaf-Extensions", owner: "AetherAssembly" },
  { name: "Driftleaf-Templates", owner: "AetherAssembly" },
];
const MAX_EXTENSION_BYTES = 512 * 1024;
const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024;

async function githubRequest(
  url: string,
  accept = "application/vnd.github+json",
): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Driftleaf",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub's release browsing limit was reached. Try again later.");
    }
    throw new Error(`GitHub release request failed (${response.status} ${response.statusText})`);
  }
  return response;
}

function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<Release>;
  return (
    typeof release.tag_name === "string" &&
    (typeof release.name === "string" || release.name === null) &&
    (typeof release.body === "string" || release.body === null) &&
    typeof release.draft === "boolean" &&
    typeof release.prerelease === "boolean" &&
    Array.isArray(release.assets) &&
    release.assets.every(
      (asset) =>
        !!asset &&
        typeof asset.id === "number" &&
        typeof asset.name === "string" &&
        typeof asset.size === "number",
    )
  );
}

async function releasesFor(repository: CommunityRepository): Promise<Release[]> {
  const { owner } = REPOSITORIES.find((item) => item.name === repository)!;
  const response = await githubRequest(
    `https://api.github.com/repos/${owner}/${repository}/releases?per_page=30`,
  );
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isRelease)) {
    throw new Error(`GitHub returned an invalid release catalog for ${repository}`);
  }
  return payload.filter((release) => !release.draft && !release.prerelease);
}

function itemsFromRelease(
  repository: CommunityRepository,
  release: Release,
): CommunityReleaseItem[] {
  const kind = repository === "Driftleaf-Extensions" ? "extension" : "template";
  const extensionAsset = (asset: ReleaseAsset) => asset.name.toLowerCase().endsWith(".js");
  const templateAsset = (asset: ReleaseAsset) => asset.name.toLowerCase().endsWith(".zip");
  return release.assets
    .filter((asset) => (kind === "extension" ? extensionAsset(asset) : templateAsset(asset)))
    .map((asset) => ({
      assetId: asset.id,
      kind,
      name: asset.name.replace(/\.(js|zip)$/i, ""),
      version: release.name?.trim() || release.tag_name,
      description:
        release.body?.trim() ||
        (kind === "extension" ? "Community JavaScript extension." : "Community vault template."),
      repository,
      size: asset.size,
    }));
}

export async function listCommunityReleases(): Promise<CommunityCatalog> {
  const catalogs = await Promise.all(
    REPOSITORIES.map(async ({ name }) => {
      try {
        const releases = await releasesFor(name);
        return {
          items: releases.flatMap((release) => itemsFromRelease(name, release)),
          error: null,
        };
      } catch (error) {
        return {
          items: [],
          error: `${name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
  return {
    items: catalogs.flatMap((catalog) => catalog.items),
    errors: catalogs.flatMap((catalog) => (catalog.error ? [catalog.error] : [])),
  };
}

async function findAsset(assetId: number, kind: CommunityReleaseItem["kind"]) {
  if (!Number.isSafeInteger(assetId) || assetId < 1) {
    throw new Error("Invalid community release asset");
  }
  const repository = kind === "extension" ? "Driftleaf-Extensions" : "Driftleaf-Templates";
  const releases = await releasesFor(repository);
  const asset = releases
    .flatMap((release) => itemsFromRelease(repository, release))
    .find((item) => item.assetId === assetId);
  if (!asset) throw new Error("This release asset is no longer available");
  return asset;
}

async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty release asset");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("The downloaded release asset is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadCommunityAsset(
  assetId: number,
  kind: CommunityReleaseItem["kind"],
): Promise<{ item: CommunityReleaseItem; bytes: Uint8Array }> {
  const item = await findAsset(assetId, kind);
  const limit = kind === "extension" ? MAX_EXTENSION_BYTES : MAX_TEMPLATE_BYTES;
  if (item.size > limit) {
    throw new Error(
      kind === "extension"
        ? "Extensions must be smaller than 512 KB"
        : "Templates must be smaller than 25 MB",
    );
  }
  const repository = REPOSITORIES.find((candidate) => candidate.name === item.repository)!;
  const response = await githubRequest(
    `https://api.github.com/repos/${repository.owner}/${repository.name}/releases/assets/${assetId}`,
    "application/octet-stream",
  );
  const finalHost = new URL(response.url).hostname;
  if (
    !["api.github.com", "github.com", "release-assets.githubusercontent.com"].includes(finalHost)
  ) {
    throw new Error("GitHub redirected the release download to an unsupported host");
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > limit) throw new Error("The downloaded release asset is too large");
  const bytes = await readLimitedBody(response, limit);
  return { item, bytes };
}
