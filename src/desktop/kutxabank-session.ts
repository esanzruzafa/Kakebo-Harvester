import type { Session } from "electron";

interface SessionFactory {
  fromPath(path: string, options: { cache: boolean }): Session;
}

export async function createPersistentKutxabankSession(
  factory: SessionFactory,
  profilePath: string
): Promise<Session> {
  const browserSession = factory.fromPath(profilePath, { cache: false });
  await browserSession.clearCache();
  return browserSession;
}
