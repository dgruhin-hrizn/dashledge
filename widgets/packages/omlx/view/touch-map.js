// Zurface registers each button from its client rect. Clip that rect to what
// the user can see, and invalidate the host map when layout moves a button.
(() => {
  const host = window.Zurface ?? window.Zeon;
  if (!host) return;
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.setAttribute("aria-hidden", "true");
  document.body.append(marker);
  const measured = new Map();
  const modelTargets = [];
  let frame = 0;
  let geometry = "";
  let directTouch = false;
  let registered = new Map();

  function visibleRect(button, measure) {
    const rect = measure();
    if (!rect.width || !rect.height) return rect;

    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    for (let parent = button.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const clipX = style.overflowX && style.overflowX !== "visible";
      const clipY = style.overflowY && style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const parentRect = parent.getBoundingClientRect();
      if (clipX) {
        left = Math.max(left, parentRect.left + parent.clientLeft);
        right = Math.min(right, parentRect.left + parent.clientLeft + parent.clientWidth);
      }
      if (clipY) {
        top = Math.max(top, parentRect.top + parent.clientTop);
        bottom = Math.min(bottom, parentRect.top + parent.clientTop + parent.clientHeight);
      }
    }
    if (right <= left || bottom <= top || window.getComputedStyle(button).visibility === "hidden") {
      return new DOMRect();
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function positionOf(rect) {
    return "left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.width + "px;height:" + rect.height + "px";
  }

  function syncModelTargets() {
    const rows = [...document.querySelectorAll("span.model-action")];
    for (let index = 0; index < Math.max(rows.length, modelTargets.length); index++) {
      const action = rows[index];
      if (!modelTargets[index]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "model-touch-target";
        const entry = { button, action: null };
        button.addEventListener("click", () => {
          const target = entry.action;
          if (!target?.isConnected || target.dataset.disabled === "true" || target.closest("[hidden]")) return;
          const current = visibleRect(target, () => target.getBoundingClientRect());
          if (current.height > 0 && positionOf(current) === button.dataset.position) target.click();
        });
        document.body.append(button);
        modelTargets.push(entry);
      }
      const entry = modelTargets[index];
      const { button } = entry;
      entry.action = action;
      const rect = action && visibleRect(action, () => action.getBoundingClientRect());
      const hidden = !rect?.width || !rect?.height;
      if (button.hidden !== hidden) button.hidden = hidden;
      if (hidden) continue;
      const position = positionOf(rect);
      if (button.dataset.position !== position) {
        button.style.cssText = position;
        button.dataset.position = position;
      }
      const disabled = action.dataset.disabled === "true";
      if (button.disabled !== disabled) button.disabled = disabled;
      if (button.getAttribute("aria-label") !== action.dataset.touchLabel) {
        button.setAttribute("aria-label", action.dataset.touchLabel);
      }
    }
  }

  function sync() {
    frame = 0;
    syncModelTargets();
    const buttons = [...document.querySelectorAll("button")];
    for (const button of measured.keys()) {
      if (button.isConnected) continue;
      resize.unobserve(button);
      measured.delete(button);
    }
    for (const button of buttons) {
      if (measured.has(button)) continue;
      const measure = button.getBoundingClientRect.bind(button);
      button.getBoundingClientRect = () => registered.get(button) ?? visibleRect(button, measure);
      measured.set(button, measure);
      resize.observe(button);
    }
    // Match the SDK's registration limit. Zurface 0.6 centers each SwiftUI
    // touch region in the widest/tallest region's frame before adding x/y.
    // Remove that centering inset from the coordinates sent to Zurface.
    const targets = buttons.slice(0, 100).map((button) => [button, visibleRect(button, measured.get(button))]);
    const visible = targets.filter(([, rect]) => rect.width > 0 && rect.height > 0);
    const maxWidth = Math.max(0, ...visible.map(([, rect]) => rect.width));
    const maxHeight = Math.max(0, ...visible.map(([, rect]) => rect.height));
    registered = new Map(targets.map(([button, rect]) => {
      if (!directTouch || !rect.width || !rect.height) return [button, rect];
      const x = rect.x - (maxWidth - rect.width) / 2;
      const y = rect.y - (maxHeight - rect.height) / 2;
      return [button, new DOMRect(x, y, rect.width, rect.height)];
    }));
    const next = JSON.stringify([...registered].map(([button, { x, y, width, height }]) =>
      [x, y, width, height, button.disabled]));
    if (next === geometry) return;
    geometry = next;
    // The SDK observes hidden and disabled, but position-only changes aren't
    // always observed. Leave the marker hidden after queuing its notification.
    marker.hidden = false;
    marker.hidden = true;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync);
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(document.body);
  const changes = new MutationObserver((records) => {
    if (records.some(({ target }) => target !== marker)) schedule();
  });
  changes.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ["class", "hidden", "disabled", "data-disabled", "style", "aria-pressed"],
  });
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  host.subscribe(({ touchMode }) => {
    if (directTouch === (touchMode === true)) return;
    directTouch = touchMode === true;
    schedule();
  });
  sync();
})();
