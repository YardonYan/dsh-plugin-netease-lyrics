/**
 * @local/netease-lyrics — Client half.
 *
 * Renders the currently sung lyric line of the desktop Netease Cloud Music
 * playback beside the host's activity line ("深度求索中，用时 …"), copying
 * that line's computed font, size, weight, and color so the two are
 * indistinguishable. When the activity line is absent, nothing renders
 * (stealth mode). The anchor text is configurable through the plugin Config
 * (`anchorText`) so non-Chinese hosts can adapt it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-netease-lyrics',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const POLL_MS = 1000;
    // Default anchor: the live status line renders exactly like
    // "深度求索中，用时 12 秒 …". Matches must stay short (the real line is
    // ~15 chars) so chat paragraphs quoting the phrase never match.
    const DEFAULT_ANCHOR_TEXT = '深度求索中，用时';
    const ANCHOR_MAX_CHARS = 60;
    const anchorRegexOf = (text) =>
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    /**
     * Read `anchorText` out of the plugin config. Only the object the host
     * passes to `apply` is trusted: probing the cordis context for it is what
     * broke activation in 1.0.0 and 1.0.1, so never reintroduce that path.
     */
    function resolveAnchorText(...sources) {
      for (const source of sources) {
        const candidate = typeof source === 'string'
          ? source
          : (source && typeof source === 'object' ? source.anchorText : null);
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
      }
      return DEFAULT_ANCHOR_TEXT;
    }

    /**
     * Log without touching `ctx.logger`. Reading an unregistered property off
     * the cordis context proxy throws during early boot, so even the error
     * path has to stay clear of it — a throw inside `catch` would escape
     * `apply` and fail the fiber just the same.
     */
    function warn(message, error) {
      try {
        console.warn(`[netease-lyrics] ${message}:`, error?.message ?? error);
      } catch {
        /* console unavailable: nothing left to report to */
      }
    }

    // Native XPath text search: C++-speed over the whole document, no node
    // cap, so it keeps working as the conversation grows long. Match the
    // first distinctive fragment in case the line splits its text across
    // nodes; the full-format regex still gates via the ancestor aggregation.
    function anchorXPathOf(anchorText) {
      const head = anchorText.slice(0, Math.max(4, Math.min(8, Math.ceil(anchorText.length / 2))));
      return `//text()[contains(normalize-space(.), '${head}')]`;
    }

    function makeAnchorFinder(anchorText) {
      const anchorRegex = anchorRegexOf(anchorText);
      const anchorXPath = anchorXPathOf(anchorText);
      function anchorCandidate(el) {
        const text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > ANCHOR_MAX_CHARS) return false;
        return anchorRegex.test(text);
      }
      return function findAnchorElement(cachedRef) {
        const cached = cachedRef.current;
        if (cached && cached.isConnected && anchorCandidate(cached)) {
          const rect = cached.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.height < 80) return cached;
        }
        let textNodes;
        try {
          textNodes = document.evaluate(
            anchorXPath, document, null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null,
          );
        } catch {
          return null;
        }
        // Walk from the LAST match backwards: the live status line is the most
        // recent one; older matches are finished turns higher up.
        let best = null;
        for (let i = textNodes.snapshotLength - 1; i >= 0 && !best; i -= 1) {
          const textNode = textNodes.snapshotItem(i);
          let el = textNode && textNode.parentElement;
          while (el && el !== document.body) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (rect.height < 80 && anchorCandidate(el)) {
                best = el;
              }
              break; // the first sized ancestor decides
            }
            el = el.parentElement;
          }
        }
        cachedRef.current = best;
        return best;
      };
    }

    function LyricsRow({ anchorText = DEFAULT_ANCHOR_TEXT }) {
      const [state, setState] = React.useState({
        hasSong: false, playing: false, title: '', artist: '',
        position: 0, rows: [], syncedAt: 0, supported: true, workerAlive: true,
      });
      const [now, setNow] = React.useState(() => Date.now());
      const [anchor, setAnchor] = React.useState(null);
      const songRef = React.useRef('');
      const localBaseRef = React.useRef({ base: 0, at: Date.now(), playing: false });
      const anchorRef = React.useRef(null);
      const spanRef = React.useRef(null);
      const [hovering, setHovering] = React.useState(false);
      const findAnchorRef = React.useRef(null);
      if (findAnchorRef.current === null) findAnchorRef.current = makeAnchorFinder(anchorText);

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        let disposed = false;
        let warnedWorker = false;
        async function tick() {
          try {
            const res = await fetch('/plugin/netease-lyrics/state');
            const data = await res.json();
            if (disposed || !data.ok) return;
            if (data.supported === false) {
              if (!warnedWorker) {
                warnedWorker = true;
                console.info('[netease-lyrics] SMTC is Windows-only; staying idle on this platform.');
              }
              return;
            }
            if (data.workerAlive === false && !warnedWorker) {
              warnedWorker = true;
              console.warn(
                '[netease-lyrics] SMTC worker is down;',
                data.workerError ? `last error: ${data.workerError}` : 'see host logs.',
              );
            }
            localBaseRef.current = { base: data.position, at: Date.now(), playing: data.playing };
            const key = `${data.title}|${data.artist}`;
            if (data.hasSong && key !== songRef.current) {
              // Fetch first, commit on success: a failed lookup must retry on
              // the next poll instead of being pinned for the whole song.
              const lyricsRes = await fetch(
                `/plugin/netease-lyrics/lyrics?title=${encodeURIComponent(data.title)}&artist=${encodeURIComponent(data.artist)}`,
              );
              const lyricsData = await lyricsRes.json();
              if (disposed) return;
              if (!Array.isArray(lyricsData.rows) || lyricsData.rows.length === 0) return;
              songRef.current = key;
              setState({
                hasSong: true, playing: data.playing, title: data.title, artist: data.artist,
                position: data.position, rows: lyricsData.rows,
                syncedAt: Date.now(), supported: true, workerAlive: data.workerAlive !== false,
              });
            } else if (data.hasSong) {
              setState((prev) => ({ ...prev, playing: data.playing, position: data.position }));
            } else {
              songRef.current = '';
              setState((prev) => (prev.hasSong ? { ...prev, hasSong: false, playing: false, rows: [] } : prev));
            }
          } catch {
            /* host unreachable: keep last state */
          }
        }
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { disposed = true; clearInterval(timer); };
      }, []);

      // Locate the activity line and copy its typography on every tick.
      // Coordinates are viewport-relative (fixed positioning against body),
      // so no self-DOM is needed — the lyric can render even before its own
      // wrapper exists, which breaks the previous null-ref deadlock.
      React.useLayoutEffect(() => {
        const anchorEl = findAnchorRef.current(anchorRef);
        if (!anchorEl) {
          setAnchor((prev) => (prev === null ? prev : null));
          return;
        }
        // Measure the anchor's REAL text end (not the container edge): walk
        // its text nodes with a Range and keep the rightmost caret rect.
        const walker = document.createTreeWalker(anchorEl, NodeFilter.SHOW_TEXT, null);
        let textNode;
        let textRight = -Infinity;
        let lastRect = null;
        while ((textNode = walker.nextNode())) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          const rects = range.getClientRects();
          for (const r of rects) {
            if (r.width > 0) {
              if (r.right > textRight) textRight = r.right;
              lastRect = r;
            }
          }
        }
        const ar = anchorEl.getBoundingClientRect();
        if (textRight === -Infinity) textRight = ar.right;
        if (ar.width === 0) {
          setAnchor((prev) => (prev === null ? prev : null));
          return;
        }
        const cs = getComputedStyle(anchorEl);
        const gap = 8;
        const next = {
          left: textRight + gap,
          top: lastRect ? lastRect.top : ar.top,
          height: lastRect ? lastRect.height : ar.height,
          maxWidth: Math.max(window.innerWidth - textRight - 24, 80),
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          color: cs.color,
          letterSpacing: cs.letterSpacing,
        };
        setAnchor((prev) => {
          if (prev && Math.abs(prev.left - next.left) < 1 && Math.abs(prev.top - next.top) < 1
            && prev.fontSize === next.fontSize && prev.color === next.color) return prev;
          return next;
        });
      }, [now, state]);

      // Hover detection without hit-testing: the lyric overlay deliberately
      // keeps `pointer-events: none` so it can never steal clicks from the
      // composer — which also means the native `title` tooltip never fires.
      // Compare the cursor against the rendered rect instead, so the full
      // line and its translation stay reachable without becoming clickable.
      React.useEffect(() => {
        if (!anchor) {
          setHovering((prev) => (prev ? false : prev));
          return undefined;
        }
        let frame = 0;
        const onMove = (event) => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            const node = spanRef.current;
            if (node === null) return;
            const rect = node.getBoundingClientRect();
            const inside = event.clientX >= rect.left && event.clientX <= rect.right
              && event.clientY >= rect.top && event.clientY <= rect.bottom;
            setHovering((prev) => (prev === inside ? prev : inside));
          });
        };
        document.addEventListener('mousemove', onMove, { passive: true });
        return () => {
          document.removeEventListener('mousemove', onMove);
          if (frame !== 0) window.cancelAnimationFrame(frame);
        };
      }, [anchor]);

      const { rows, hasSong } = state;
      const base = localBaseRef.current;
      const position = base.playing ? base.base + (now - base.at) / 1000 : base.base;

      let active = null;
      if (hasSong && rows.length > 0) {
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i].time <= position) active = rows[i];
          else break;
        }
      }
      if (!hasSong || !active || !active.text) return null;
      // Stealth mode: only render while the activity line exists. Without it,
      // visible lyrics would give the disguise away.
      if (!anchor) return null;

      // Anchored mode: viewport-fixed span beside the activity line with
      // identical typography. The wrapper itself stays zero-size so the dock
      // slot keeps its layout.
      const detail = active.trans ? `${active.text}\n${active.trans}` : active.text;
      const tipWidth = 320;
      const tipLeft = Math.max(8, Math.min(anchor.left, window.innerWidth - tipWidth - 16));
      return h('div', { style: { height: 0 } },
          h('span', {
            ref: spanRef,
            style: {
              position: 'fixed',
              left: anchor.left,
              top: anchor.top,
              height: anchor.height,
              maxWidth: anchor.maxWidth,
              display: 'inline-flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              userSelect: 'none',
              fontFamily: anchor.fontFamily,
              fontSize: anchor.fontSize,
              fontWeight: anchor.fontWeight,
              lineHeight: anchor.lineHeight,
              color: anchor.color,
              letterSpacing: anchor.letterSpacing,
            },
          }, active.text),
          hovering
            ? h('div', {
                style: {
                  position: 'fixed',
                  left: tipLeft,
                  top: Math.max(anchor.top - 34, 8),
                  maxWidth: tipWidth,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'rgba(23, 23, 26, 0.95)',
                  color: '#ffffff',
                  fontFamily: anchor.fontFamily,
                  fontSize: '12px',
                  fontWeight: 400,
                  lineHeight: '18px',
                  letterSpacing: 0,
                  whiteSpace: 'pre-line',
                  pointerEvents: 'none',
                  userSelect: 'none',
                  zIndex: 2147483647,
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
                },
              }, detail)
            : null,
      );
    }

    return {
      apply(ctx, config) {
        try {
          // `anchorText` lets non-Chinese hosts retarget the status line; a
          // missing or malformed value keeps the built-in behaviour. Read the
          // plugin config only — never probe the ctx proxy for it: property
          // access on the cordis context (ctx.config/ctx.options/…) throws
          // during early boot, and the swallowed error fails the whole fiber,
          // which blocks the host's web boot.
          const anchorText = resolveAnchorText(
            config && typeof config === 'object' ? config.anchorText : undefined,
          );
          // The dock is mounted through `ctx.inject(['slots'])`, which waits
          // for the service instead of reading it at activation time. Every
          // step is guarded: worst case the lyrics stay idle.
          const mountDock = (scope) => {
            try {
              const slots = (scope && scope.slots)
                || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
              if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
              slots.inject('conversation.input.dock', () =>
                slots.register(
                  { name: 'conversation.input.dock', id: 'netease-lyrics', order: 5 },
                  (props) => h(LyricsRow, { ...props, anchorText }),
                ),
              );
            } catch (error) {
              warn('dock slot unavailable, staying idle', error);
            }
          };
          if (typeof ctx.inject === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(
              () => ctx.inject(['slots'], mountDock),
              'netease-lyrics: dock slot',
            );
            return;
          }
          mountDock(ctx);
        } catch (error) {
          warn('activation degraded, staying idle', error);
        }
      },
    };
  },
});
