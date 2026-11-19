// NAME: stats.fm for Spicetify
// DESCRIPTION: Shows your stats.fm top tracks, artists, albums and genres inside Spotify,
//              plus a "stats.fm plays" right-click item on songs.
//              Uses the public stats.fm API (api.stats.fm), not Spotify's rate-limited Web API.
// VERSION: 2.2

(function statsfm() {
	if (!(window.Spicetify && Spicetify.PopupModal && Spicetify.ContextMenu && Spicetify.URI && Spicetify.showNotification)) {
		setTimeout(statsfm, 300);
		return;
	}

	const API = "https://api.stats.fm/api/v1";
	const KEY_USER = "statsfm:username";
	const KEY_VIEW = "statsfm:view";
	const RANGES = [
		{ id: "weeks", label: "4 weeks" },
		{ id: "months", label: "6 months" },
		{ id: "lifetime", label: "All time" },
	];
	const TABS = [
		{ id: "tracks", label: "Tracks" },
		{ id: "artists", label: "Artists" },
		{ id: "albums", label: "Albums" },
		{ id: "genres", label: "Genres" },
	];
	const CACHE_MS = 5 * 60 * 1000;
	const DAY = 864e5;
	const RANGE_DAYS = { weeks: 28, months: 182 };

	// Send both the named range and explicit dates, so the time range applies
	// whichever form the stats.fm API honors. Rounded to the hour to keep URLs cacheable.
	function rangeQuery(range) {
		const now = Math.ceil(Date.now() / 36e5) * 36e5;
		const days = RANGE_DAYS[range];
		const after = days ? now - days * DAY : 0;
		return `range=${range}&after=${after}&before=${now}`;
	}
	const cache = new Map();

	// ---------- storage ----------
	const store = {
		get(k, d) {
			try {
				const v = localStorage.getItem(k);
				return v == null ? d : JSON.parse(v);
			} catch {
				return d;
			}
		},
		set(k, v) {
			try {
				localStorage.setItem(k, JSON.stringify(v));
			} catch {}
		},
	};
	const view = Object.assign({ tab: "tracks", range: "weeks" }, store.get(KEY_VIEW, {}));
	const getUser = () => store.get(KEY_USER, "") || "";

	// ---------- helpers ----------
	const esc = (v) =>
		String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const num = (n) => (n == null || isNaN(n) ? "" : Number(n).toLocaleString());
	const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

	function formatMs(ms) {
		if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
		const mins = Math.round(ms / 60000);
		if (mins < 60) return `${mins} min`;
		const hrs = mins / 60;
		return hrs < 100 ? `${hrs.toFixed(1)} h` : `${Math.round(hrs).toLocaleString()} h`;
	}

	function cleanUsername(v) {
		return v
			.trim()
			.replace(/^https?:\/\/(www\.)?stats\.fm\//i, "")
			.replace(/^(user|u)\//i, "")
			.replace(/[/?#].*$/, "");
	}

	class StatsFmError extends Error {
		constructor(message, status) {
			super(message);
			this.status = status;
		}
	}

	async function api(path) {
		const url = API + path;
		const hit = cache.get(url);
		if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;

		let res;
		try {
			res = await fetch(url, { headers: { Accept: "application/json" } });
		} catch {
			throw new StatsFmError("Couldn't reach stats.fm. Check your connection and try again.", 0);
		}
		if (res.status === 404) throw new StatsFmError("That stats.fm user doesn't exist. Check the username.", 404);
		if (res.status === 401 || res.status === 403)
			throw new StatsFmError("This stats.fm profile is private. Make it public in stats.fm → Settings → Privacy.", res.status);
		if (res.status === 429) throw new StatsFmError("stats.fm is rate-limiting requests. Try again in a minute.", 429);
		if (!res.ok) throw new StatsFmError(`stats.fm returned an error (${res.status}). Try again later.`, res.status);

		const data = await res.json();
		cache.set(url, { time: Date.now(), data });
		return data;
	}
	const userPath = (u) => `/users/${encodeURIComponent(u)}`;
	const spotifyId = (o) => {
		const ids = o && o.externalIds && o.externalIds.spotify;
		return Array.isArray(ids) && ids.length ? ids[0] : null;
	};

	// Keep clicks inside the popup from reaching Spotify's "click outside closes the modal" handler.
	function guard(el) {
		["click", "mousedown", "mouseup", "pointerdown", "pointerup"].forEach((t) =>
			el.addEventListener(t, (e) => e.stopPropagation())
		);
	}

	// ---------- styles ----------
	const CSS = `
	.sfm { color: var(--spice-text, #fff); width: min(640px, 82vw); font-size: 14px; }
	.sfm * { box-sizing: border-box; }
	.sfm-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
	.sfm-avatar { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: rgba(255,255,255,.1); flex-shrink: 0; }
	.sfm-who { flex: 1; min-width: 0; }
	.sfm-who b { display: block; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sfm-who a { font-size: 12px; color: var(--spice-subtext, #b3b3b3); text-decoration: none; }
	.sfm-who a:hover { text-decoration: underline; }
	.sfm-link { background: none; border: 0; color: var(--spice-subtext, #b3b3b3); font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 4px; }
	.sfm-link:hover { color: var(--spice-text, #fff); background: rgba(255,255,255,.07); }

	.sfm-controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 14px; }
	.sfm-seg { display: inline-flex; background: rgba(255,255,255,.07); border-radius: 999px; padding: 3px; }
	.sfm-seg button { background: none; border: 0; color: var(--spice-subtext, #b3b3b3); font-size: 13px; font-weight: 600;
		padding: 6px 13px; border-radius: 999px; cursor: pointer; transition: background .15s, color .15s; }
	.sfm-seg button:hover { color: var(--spice-text, #fff); }
	.sfm-seg button[aria-pressed="true"] { background: var(--spice-text, #fff); color: var(--spice-main, #121212); }

	.sfm-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
	.sfm-card { background: rgba(255,255,255,.06); border-radius: 8px; padding: 10px 12px; min-height: 58px; }
	.sfm-card b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
	.sfm-card span { font-size: 12px; color: var(--spice-subtext, #b3b3b3); }

	.sfm-list { max-height: 52vh; overflow-y: auto; margin: 0 -6px; padding: 0 6px; }
	.sfm-row { display: grid; grid-template-columns: 28px 44px 1fr auto; align-items: center; gap: 12px;
		padding: 6px 8px; border-radius: 6px; }
	.sfm-row.nolead { grid-template-columns: 28px 1fr auto; }
	.sfm-row[data-id]:not([data-id=""]) { cursor: pointer; }
	.sfm-row[data-id]:not([data-id=""]):hover { background: rgba(255,255,255,.08); }
	.sfm-pos { text-align: right; color: var(--spice-subtext, #b3b3b3); font-variant-numeric: tabular-nums; }
	.sfm-img { width: 44px; height: 44px; border-radius: 4px; object-fit: cover; background: rgba(255,255,255,.08); display: block; }
	.sfm-img.round { border-radius: 50%; }
	.sfm-main { min-width: 0; }
	.sfm-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sfm-sub { font-size: 12px; color: var(--spice-subtext, #b3b3b3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sfm-bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,.1); margin-top: 5px; overflow: hidden; }
	.sfm-bar i { display: block; height: 100%; background: var(--spice-button, #1ed760); border-radius: 2px; }
	.sfm-stat { text-align: right; font-size: 12px; color: var(--spice-subtext, #b3b3b3); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.sfm-stat b { color: var(--spice-text, #fff); font-weight: 600; }

	.sfm-msg { padding: 36px 12px; text-align: center; color: var(--spice-subtext, #b3b3b3); line-height: 1.6; }
	.sfm-skel { background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.11), rgba(255,255,255,.05));
		background-size: 200% 100%; animation: sfm-shimmer 1.2s infinite; border-radius: 4px; }
	@keyframes sfm-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
	.sfm-fade { animation: sfm-in .18s ease-out; }
	@keyframes sfm-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

	.sfm-setup { padding: 8px 0 4px; }
	.sfm-setup p { color: var(--spice-subtext, #b3b3b3); line-height: 1.6; margin: 0 0 14px; }
	.sfm-setup .sfm-err { color: #f3727f; }
	.sfm-form { display: flex; gap: 8px; }
	.sfm-input { flex: 1; background: rgba(255,255,255,.08); color: var(--spice-text, #fff); border: 1px solid rgba(255,255,255,.15);
		border-radius: 6px; padding: 9px 12px; font-size: 14px; outline: none; }
	.sfm-input:focus { border-color: var(--spice-text, #fff); }
	.sfm-primary { background: var(--spice-button, #1ed760); color: #000; border: 0; border-radius: 999px; padding: 9px 20px;
		font-weight: 700; cursor: pointer; }
	.sfm-primary:hover { filter: brightness(1.1); transform: scale(1.03); }

	.sfm-tbl { width: 100%; border-collapse: collapse; }
	.sfm-tbl td { padding: 8px 4px; border-bottom: 1px solid rgba(255,255,255,.07); font-variant-numeric: tabular-nums; }
	.sfm-tbl td:first-child { color: var(--spice-subtext, #b3b3b3); }
	.sfm-tbl td:not(:first-child) { text-align: right; }

	@media (max-width: 560px) { .sfm-cards { grid-template-columns: repeat(2, 1fr); } }
	`;

	// ---------- main popup ----------
	function openStats() {
		const root = document.createElement("div");
		root.className = "sfm";
		root.innerHTML = `<style>${CSS}</style><div class="sfm-body"></div>`;
		guard(root);
		Spicetify.PopupModal.display({ title: "stats.fm", content: root, isLarge: true });
		const body = root.querySelector(".sfm-body");
		getUser() ? showStats(body) : showSetup(body);
	}

	function showSetup(body, error) {
		body.innerHTML = `
		<div class="sfm-setup sfm-fade">
			<p>Enter your <b>stats.fm username</b> or paste your profile link. Your stats.fm profile needs to be public.</p>
			${error ? `<p class="sfm-err">${esc(error)}</p>` : ""}
			<div class="sfm-form">
				<input class="sfm-input" placeholder="username or stats.fm/… link" value="${esc(getUser())}" spellcheck="false">
				<button class="sfm-primary" type="button">Save</button>
			</div>
		</div>`;
		const input = body.querySelector(".sfm-input");
		const save = async () => {
			const u = cleanUsername(input.value);
			if (!u) return input.focus();
			const btn = body.querySelector(".sfm-primary");
			btn.textContent = "Checking…";
			btn.disabled = true;
			try {
				cache.clear();
				await api(userPath(u));
				store.set(KEY_USER, u);
				showStats(body);
			} catch (e) {
				showSetup(body, e.message);
				body.querySelector(".sfm-input").value = u;
			}
		};
		body.querySelector(".sfm-primary").addEventListener("click", save);
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") save();
		});
		setTimeout(() => input.focus(), 50);
	}

	function showStats(body) {
		const user = getUser();
		const seg = (items, key) =>
			`<div class="sfm-seg" role="group">${items
				.map((i) => `<button type="button" data-${key}="${i.id}" aria-pressed="${view[key] === i.id}">${i.label}</button>`)
				.join("")}</div>`;

		body.innerHTML = `
		<div class="sfm-head">
			<img class="sfm-avatar" alt="">
			<div class="sfm-who"><b>${esc(user)}</b><a href="https://stats.fm/${encodeURIComponent(user)}" target="_blank" rel="noopener">View on stats.fm ↗</a></div>
			<button type="button" class="sfm-link" data-action="change">Change user</button>
		</div>
		<div class="sfm-controls">${seg(TABS, "tab")}${seg(RANGES, "range")}</div>
		<div class="sfm-cards"></div>
		<div class="sfm-list"></div>`;

		// Profile name + picture
		api(userPath(user))
			.then((r) => {
				const p = r && r.item;
				if (!p) return;
				if (p.displayName) body.querySelector(".sfm-who b").textContent = p.displayName;
				const img = body.querySelector(".sfm-avatar");
				if (p.image) img.src = p.image;
				if (p.customId)
					body.querySelector(".sfm-who a").href = `https://stats.fm/${encodeURIComponent(p.customId)}`;
			})
			.catch(() => {});

		// Controls: update in place, never rebuild the clicked button.
		body.querySelector(".sfm-controls").addEventListener("click", (e) => {
			const b = e.target.closest("button");
			if (!b) return;
			const key = b.dataset.tab ? "tab" : b.dataset.range ? "range" : null;
			if (!key || view[key] === b.dataset[key]) return;
			view[key] = b.dataset[key];
			store.set(KEY_VIEW, view);
			body.querySelectorAll(`[data-${key}]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
			loadData(body);
		});
		body.querySelector('[data-action="change"]').addEventListener("click", () => showSetup(body));

		// Rows: open in Spotify
		body.querySelector(".sfm-list").addEventListener("click", (e) => {
			const row = e.target.closest(".sfm-row");
			if (!row || !row.dataset.id) return;
			Spicetify.PopupModal.hide();
			Spicetify.Platform?.History?.push(`/${row.dataset.type}/${row.dataset.id}`);
		});

		loadData(body);
	}

	// Totals for a range. /streams/stats ignores the time range, so ranged totals come from
	// /streams/stats/dates (which needs a time zone) by summing its per-hour buckets.
	const TZ = (() => {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		} catch {
			return "UTC";
		}
	})();
	async function loadTotals(user, range) {
		const base = await api(`${userPath(user)}/streams/stats?${rangeQuery(range)}`)
			.then((r) => r && r.items)
			.catch(() => null);
		const totals = base
			? {
					count: base.count,
					durationMs: base.durationMs,
					tracks: base.cardinality && base.cardinality.tracks,
					artists: base.cardinality && base.cardinality.artists,
			  }
			: null;
		if (range === "lifetime") return totals;

		try {
			const tz = `timeZone=${encodeURIComponent(TZ)}&timeZoneOffset=${-new Date().getTimezoneOffset()}`;
			const r = await api(`${userPath(user)}/streams/stats/dates?${rangeQuery(range)}&${tz}`);
			const hours = r && r.items && r.items.hours;
			if (hours && typeof hours === "object") {
				let count = 0,
					durationMs = 0;
				for (const b of Object.values(hours)) {
					count += b.count || 0;
					durationMs += b.durationMs || 0;
				}
				return { count, durationMs };
			}
		} catch (e) {
			console.warn("[statsfm] ranged totals unavailable", e);
		}
		return totals && { count: totals.count, durationMs: totals.durationMs, approximate: true };
	}

	let loadToken = 0;
	async function loadData(body) {
		const token = ++loadToken;
		const user = getUser();
		const { tab, range } = view;
		const list = body.querySelector(".sfm-list");
		const cards = body.querySelector(".sfm-cards");

		list.innerHTML = Array.from(
			{ length: 8 },
			() => `<div class="sfm-row"><div></div><div class="sfm-img sfm-skel"></div>
				<div><div class="sfm-skel" style="height:12px;width:55%"></div><div class="sfm-skel" style="height:10px;width:35%;margin-top:6px"></div></div><div></div></div>`
		).join("");
		cards.innerHTML = Array.from({ length: 4 }, () => `<div class="sfm-card sfm-skel"></div>`).join("");

		const topP = api(`${userPath(user)}/top/${tab}?${rangeQuery(range)}&limit=50`).then((r) => (r && r.items) || []);

		loadTotals(user, range).then((t) => {
			if (token !== loadToken) return;
			const card = (v, label) => `<div class="sfm-card sfm-fade"><b>${esc(v || "–")}</b><span>${label}</span></div>`;
			if (!t) {
				cards.innerHTML = "";
				return;
			}
			const days = t.approximate ? 0 : RANGE_DAYS[range];
			const sfx = t.approximate ? " (all time)" : "";
			cards.innerHTML =
				card(num(t.count), "streams" + sfx) +
				card(formatMs(t.durationMs), "listened" + sfx) +
				(t.approximate ? "" : days
					? card(num(Math.round(t.count / days)), "streams / day") + card(formatMs(t.durationMs / days), "per day")
					: card(num(t.tracks), "tracks") + card(num(t.artists), "artists"));
		});

		try {
			const items = await topP;
			if (token !== loadToken) return;
			if (!items.length) {
				list.innerHTML = `<div class="sfm-msg">Nothing here yet for this time range.<br>
					New stats.fm accounts take a little while to collect plays. Importing your Spotify history on stats.fm fills in "All time".</div>`;
				return;
			}
			const max = Math.max(...items.map((i) => i.streams || 0), 1);
			list.innerHTML = `<div class="sfm-fade">${items.map((i) => rowHtml(i, tab, max)).join("")}</div>`;
		} catch (e) {
			if (token !== loadToken) return;
			if (e instanceof StatsFmError && e.status === 404) return showSetup(body, e.message);
			list.innerHTML = `<div class="sfm-msg">${esc(e.message || e)}</div>`;
			console.warn("[statsfm]", e);
		}
	}

	function rowHtml(item, kind, max) {
		const pct = Math.max(2, Math.round(((item.streams || 0) / max) * 100));
		const time = formatMs(item.playedMs);
		const stat = `<div class="sfm-stat">${item.streams != null ? `<b>${num(item.streams)}</b> plays` : ""}${
			time ? `<br>${esc(time)}` : ""
		}</div>`;
		const bar = item.streams != null ? `<div class="sfm-bar"><i style="width:${pct}%"></i></div>` : "";
		const img = (src, round) =>
			src ? `<img class="sfm-img${round ? " round" : ""}" src="${esc(src)}" loading="lazy" alt="">` : `<div class="sfm-img${round ? " round" : ""}"></div>`;
		const row = (type, id, lead, name, sub) =>
			`<div class="sfm-row${lead === null ? " nolead" : ""}" data-type="${type}" data-id="${esc(id || "")}">
				<div class="sfm-pos">${esc(item.position ?? "")}</div>${lead === null ? "" : lead}
				<div class="sfm-main"><div class="sfm-name">${esc(name)}</div><div class="sfm-sub">${esc(sub)}</div>${bar}</div>${stat}</div>`;

		if (kind === "tracks") {
			const t = item.track || {};
			return row("track", spotifyId(t), img(t.albums && t.albums[0] && t.albums[0].image), t.name, (t.artists || []).map((a) => a.name).join(", "));
		}
		if (kind === "artists") {
			const a = item.artist || {};
			return row("artist", spotifyId(a), img(a.image, true), a.name, (a.genres || []).slice(0, 3).map(cap).join(", "));
		}
		if (kind === "albums") {
			const al = item.album || {};
			return row("album", spotifyId(al), img(al.image), al.name, (al.artists || []).map((a) => a.name).join(", "));
		}
		const g = item.genre || {};
		const preview = (item.previewArtists || []).map((p) => p.artist && p.artist.name).filter(Boolean).slice(0, 3).join(", ");
		return row("genre", "", null, cap(g.tag), preview);
	}

	// ---------- per-song plays (right-click) ----------
	async function showTrackPlays(uris) {
		const user = getUser();
		if (!user) return openStats();
		const sid = uris[0].split(":")[2];
		try {
			const t = await api(`/tracks/${encodeURIComponent(sid)}?type=spotify`);
			const track = t && t.item;
			if (!track || track.id == null) throw new StatsFmError("stats.fm doesn't know this song yet.", 404);

			const results = await Promise.all(
				RANGES.map((r) =>
					api(`${userPath(user)}/streams/tracks/${track.id}/stats?${rangeQuery(r.id)}`)
						.then((x) => (x && x.items) || null)
						.catch(() => null)
				)
			);
			const cover = track.albums && track.albums[0] && track.albums[0].image;
			const root = document.createElement("div");
			root.className = "sfm";
			root.style.width = "min(420px, 82vw)";
			guard(root);
			root.innerHTML = `<style>${CSS}</style>
				<div class="sfm-head">
					${cover ? `<img class="sfm-img" src="${esc(cover)}" alt="" style="width:56px;height:56px">` : ""}
					<div class="sfm-who"><b>${esc(track.name)}</b><span class="sfm-sub">${esc((track.artists || []).map((a) => a.name).join(", "))}</span></div>
				</div>
				<table class="sfm-tbl">${RANGES.map((r, i) => {
					const s = results[i];
					return `<tr><td>${r.label}</td><td><b>${s ? num(s.count) || "0" : "–"}</b> plays</td><td>${esc((s && formatMs(s.durationMs)) || "")}</td></tr>`;
				}).join("")}</table>
				<p class="sfm-sub" style="margin-top:12px">Your plays on stats.fm (${esc(user)})</p>`;
			Spicetify.PopupModal.display({ title: "stats.fm plays", content: root });
		} catch (e) {
			Spicetify.showNotification(`stats.fm: ${e.message || e}`, true);
		}
	}

	const isSingleTrack = (uris) => uris.length === 1 && Spicetify.URI.fromString(uris[0]).type === Spicetify.URI.Type.TRACK;
	const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>`;

	new Spicetify.ContextMenu.Item("stats.fm plays", showTrackPlays, isSingleTrack, ICON).register();

	try {
		if (Spicetify.Topbar && Spicetify.Topbar.Button) new Spicetify.Topbar.Button("stats.fm", ICON, openStats);
	} catch (e) {
		console.warn("[statsfm] Topbar button failed", e);
	}
	try {
		if (Spicetify.Menu && Spicetify.Menu.Item) new Spicetify.Menu.Item("stats.fm", false, openStats, ICON).register();
	} catch (e) {
		console.warn("[statsfm] Menu item failed", e);
	}

	window.openStatsFm = openStats;
	console.log("[statsfm] loaded");
})();
