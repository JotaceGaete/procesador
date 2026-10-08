// Every method of every API route (tests/unit/routes.test.ts checks the list is complete).
// `scope` says which id the path carries, so the security tests can aim each one at a real
// element of a locked novel: novel, chapter, version, asset, character, characterImage,
// manuscriptImage, memory, conversation, observation, thread; "body" carries novelId in the
// JSON; "session" touches no novel; "open" is before or outside a session.
const r = (method, route, scope) => ({ method, route, scope });

export const ROUTES = [
  r("POST", "login", "open"),
  r("POST", "logout", "open"),
  r("GET", "version", "open"),

  r("GET", "session", "session"),
  r("POST", "session/ping", "session"),
  r("POST", "session/lock", "session"),
  r("POST", "session/unlock", "session"),
  r("GET", "settings", "session"),
  r("PATCH", "settings", "session"),
  r("GET", "novels", "session"),
  r("POST", "novels", "session"),

  r("GET", "novels/[id]", "novel"),
  r("PATCH", "novels/[id]", "novel"),
  r("DELETE", "novels/[id]", "novel"),
  r("POST", "novels/[id]/advisor", "novel"),
  r("POST", "novels/[id]/assets", "novel"),
  r("GET", "novels/[id]/backup", "novel"),
  r("POST", "novels/[id]/chapters", "novel"),
  r("PUT", "novels/[id]/chapters", "novel"),
  r("GET", "novels/[id]/chronology", "novel"),
  r("PATCH", "novels/[id]/chronology", "novel"),
  r("GET", "novels/[id]/conversations", "novel"),
  r("POST", "novels/[id]/digest", "novel"),
  r("POST", "novels/[id]/duplicate", "novel"),
  r("GET", "novels/[id]/manuscript-images", "novel"),
  r("POST", "novels/[id]/manuscript-images", "novel"),
  r("POST", "novels/[id]/memory/[kind]", "novel"),
  r("GET", "novels/[id]/observations", "novel"),
  r("GET", "novels/[id]/reading", "novel"),
  r("GET", "novels/[id]/threads", "novel"),
  r("POST", "novels/[id]/threads", "novel"),
  r("GET", "novels/[id]/trash", "novel"),
  r("POST", "novels/[id]/trash", "novel"),
  r("POST", "novels/[id]/unlock", "novel"),
  r("POST", "novels/[id]/lock", "novel"),
  r("PUT", "novels/[id]/protection", "novel"),
  r("PATCH", "novels/[id]/protection", "novel"),
  r("DELETE", "novels/[id]/protection", "novel"),
  r("POST", "novels/[id]/protection/recover", "novel"),

  r("GET", "chapters/[id]", "chapter"),
  r("PATCH", "chapters/[id]", "chapter"),
  r("DELETE", "chapters/[id]", "chapter"),
  r("POST", "chapters/[id]/digest", "chapter"),
  r("PATCH", "chapters/[id]/digest", "chapter"),
  r("PUT", "chapters/[id]/time", "chapter"),
  r("DELETE", "chapters/[id]/time", "chapter"),
  r("GET", "chapters/[id]/versions", "chapter"),
  r("POST", "chapters/[id]/versions", "chapter"),
  r("GET", "versions/[id]", "version"),

  r("GET", "assets/[id]/[variant]", "asset"),
  r("POST", "assets/[id]/complete", "asset"),
  r("POST", "characters/[id]/images", "character"),
  r("PUT", "characters/[id]/images", "character"),
  r("PATCH", "character-images/[id]", "characterImage"),
  r("DELETE", "character-images/[id]", "characterImage"),
  r("POST", "character-images/[id]/primary", "characterImage"),
  r("POST", "character-images/[id]/replace", "characterImage"),
  r("PATCH", "manuscript-images/[id]", "manuscriptImage"),
  r("DELETE", "manuscript-images/[id]", "manuscriptImage"),
  r("POST", "manuscript-images/[id]/duplicate", "manuscriptImage"),
  r("POST", "manuscript-images/[id]/replace", "manuscriptImage"),

  r("PATCH", "memory/[kind]/[id]", "memory"),
  r("DELETE", "memory/[kind]/[id]", "memory"),

  r("GET", "conversations/[id]", "conversation"),
  r("PATCH", "conversations/[id]", "conversation"),
  r("DELETE", "conversations/[id]", "conversation"),
  r("PATCH", "observations/[id]", "observation"),
  r("POST", "observations/[id]/recheck", "observation"),
  r("PATCH", "threads/[id]", "thread"),
  r("DELETE", "threads/[id]", "thread"),
  r("POST", "threads/[id]/merge", "thread"),

  r("POST", "assist", "body"),
  r("POST", "advisor", "body"),
];

/** The URL of a route for the given ids ({ novel, chapter, … }); memory items are characters. */
export function routeUrl({ route, scope }, ids) {
  let url = "/api/" + route;
  const id = scope === "body" || scope === "session" || scope === "open" ? undefined : ids[scope];
  url = url.replace("[kind]", route.startsWith("memory/") ? "characters" : "facts");
  url = url.replace("[variant]", "thumb");
  if (id) url = url.replace("[id]", id);
  if (route === "assets/[id]/[variant]") url += `?v=${ids.assetVersion ?? 1}`;
  return url;
}

/** A body that would do something real, so a missing check shows (the locked novel's ids inside). */
export function routeBody({ route, scope }, ids) {
  if (scope === "body") return { novelId: ids.novel, chapterId: ids.chapter, provider: "anthropic", dryRun: true, content: "x", mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: 1 };
  if (route === "chapters/[id]") return { content: "SOBRESCRITO", revision: ids.chapterRevision ?? 0, title: "SOBRESCRITO" };
  if (route === "novels/[id]") return { title: "SOBRESCRITO" };
  if (route === "memory/[kind]/[id]") return { name: "SOBRESCRITO" };
  if (route === "novels/[id]/memory/[kind]") return { text: "SOBRESCRITO" };
  if (route === "novels/[id]/chapters") return { title: "SOBRESCRITO" };
  if (route === "chapters/[id]/versions") return { reason: "manual" };
  // Trying to take the protection off (or put another PIN) without knowing the current one.
  if (route === "novels/[id]/protection") return { kind: "pin", secret: "999999", idleMinutes: 60, hideTitle: false };
  if (route === "novels/[id]/protection/recover") return { appPassword: "no", action: "remove" };
  return {};
}
