import { Dropbox } from 'dropbox';
import type { files } from 'dropbox';

export type VideoFile = files.FileMetadataReference & {
  path_display: string;
  name: string;
  size: number;
  client_modified: string;
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv']);

function isVideo(entry: files.MetadataReference): entry is VideoFile {
  if (entry['.tag'] !== 'file') return false;
  const name = entry.name.toLowerCase();
  return VIDEO_EXTENSIONS.has(name.slice(name.lastIndexOf('.')));
}

export async function listAllVideos(accessToken: string, path = ''): Promise<VideoFile[]> {
  const dbx = new Dropbox({ accessToken });
  const videos: VideoFile[] = [];

  async function fetchFolder(folderPath: string) {
    let response = await dbx.filesListFolder({ path: folderPath, recursive: true });

    for (const entry of response.result.entries) {
      if (isVideo(entry)) videos.push(entry as VideoFile);
    }

    while (response.result.has_more) {
      response = await dbx.filesListFolderContinue({ cursor: response.result.cursor });
      for (const entry of response.result.entries) {
        if (isVideo(entry)) videos.push(entry as VideoFile);
      }
    }
  }

  await fetchFolder(path);
  return videos.sort((a, b) => a.path_display.localeCompare(b.path_display));
}

export async function getTemporaryLink(accessToken: string, path: string): Promise<string> {
  const dbx = new Dropbox({ accessToken });
  const response = await dbx.filesGetTemporaryLink({ path });
  return response.result.link;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
