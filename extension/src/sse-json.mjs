// WebMCP Translator Kit — Incremental LLM-JSON results parser (SSE helper)
// Pure module: no chrome.* APIs, no network. Feeds on streamed text deltas
// and emits each fully-received {"id","revision","text"} result item ASAP so
// the DOM can be patched progressively instead of waiting for the whole
// streamed JSON document.
//
// Expected document shape (same as parseLlmJson):
//   {"results": [{"id": "...", "revision": 0, "text": "..."}, ...]}
// Fences (```json ... ```) are stripped. Pretty-printed layouts work: items
// are extracted by brace-depth scanning with string/escape awareness.

export function createIncrementalResultsParser() {
  let buffer = '';
  let fenceStripped = false;
  let arrayStarted = false;
  let itemStart = -1;
  let scannedUpTo = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const items = [];
  let malformed = 0;

  function stripLeadingFence() {
    const m = buffer.match(/^\s*```(?:json)?\s*/i);
    if (m) buffer = buffer.slice(m[0].length);
  }

  function tryStartArray() {
    // Find `"results"` key followed by `[` in the buffered (fence-stripped) text
    const m = buffer.match(/"results"\s*:\s*\[/);
    if (m) {
      arrayStarted = true;
      // Drop everything up to and including the opening bracket
      buffer = buffer.slice(m.index + m[0].length);
      scannedUpTo = 0;
      itemStart = -1;
      depth = 0;
      inString = false;
      escaped = false;
      return true;
    }
    // Keep only a bounded tail while the header hasn't arrived (tokens may
    // split `"results": [` across chunk boundaries)
    if (buffer.length > 512) buffer = buffer.slice(-512);
    return false;
  }

  function scanItems() {
    const done = [];
    let dropUpTo = 0;
    // Resume where the previous push left off: re-scanning the prefix would
    // double-count braces and re-emit items.
    if (scannedUpTo > buffer.length) scannedUpTo = buffer.length;
    let i = scannedUpTo;
    while (i < buffer.length) {
      const ch = buffer[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) itemStart = i;
        depth++;
        i++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0 && itemStart !== -1) {
          const raw = buffer.slice(itemStart, i + 1);
          itemStart = -1;
          try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj.id === 'string' && typeof obj.revision === 'number' && typeof obj.text === 'string') {
              items.push(obj);
              done.push(obj);
              dropUpTo = i + 1;
            } else {
              malformed++;
              dropUpTo = i + 1;
            }
          } catch {
            malformed++;
            dropUpTo = i + 1;
          }
        } else if (depth < 0) {
          // Unbalanced: resync (trailing `]}` etc. is handled by finish())
          depth = 0;
          itemStart = -1;
        }
        i++;
        continue;
      }
      if (ch === ']' && depth === 0) {
        // End of results array: drop the consumed prefix, keep the tail
        buffer = buffer.slice(i + 1);
        itemStart = -1;
        scannedUpTo = 0;
        return done;
      }
      i++;
    }
    scannedUpTo = buffer.length;
    // Drop emitted prefix so items are never re-emitted on later pushes
    if (dropUpTo > 0) {
      buffer = buffer.slice(dropUpTo);
      if (itemStart !== -1) itemStart -= dropUpTo;
      scannedUpTo = buffer.length;
      return done;
    }
    // Drop fully-consumed prefix (everything before an in-progress item)
    if (itemStart > 0) {
      buffer = buffer.slice(itemStart);
      itemStart = 0;
      scannedUpTo = buffer.length;
    } else if (itemStart === -1 && depth === 0) {
      // Only separators/whitespace seen: compact to bounded tail
      if (buffer.length > 256) {
        buffer = buffer.slice(-256);
        scannedUpTo = buffer.length;
      }
    }
    return done;
  }

  return {
    // Feed one streamed text delta. Returns newly completed valid items.
    push(chunk) {
      if (!chunk || typeof chunk !== 'string') return [];
      buffer += chunk;
      if (!fenceStripped) {
        stripLeadingFence();
        // Only mark done once real content starts (a fence may arrive split)
        if (/^\s*```/i.test(chunk) || buffer.length > 0) fenceStripped = true;
      }
      if (!arrayStarted) {
        if (!tryStartArray()) return [];
      }
      return scanItems();
    },
    // Call when the stream ends. Returns { items, malformed, truncated }.
    // A trailing ``` fence is tolerated; leftover partial item = truncated.
    finish() {
      buffer = buffer.replace(/\s*```\s*$/, '');
      const done = arrayStarted ? scanItems() : [];
      void done;
      const truncated = arrayStarted && (itemStart !== -1 || depth > 0 || inString);
      return { items: [...items], malformed, truncated };
    },
    stats() {
      return { items: items.length, malformed, buffered: buffer.length };
    }
  };
}
