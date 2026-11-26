// The host maps native buttons before hit testing and does not clip their bounds
// to scrolling ancestors. Publish only the visible part of each interactive row.
(() => {
  const registry = document.createElement("div");
  registry.className = "visible-controls";
  document.body.append(registry);
  const panes = ["workspace-list", "messages", "plan-list"].map(id => document.getElementById(id));
  const latest = document.getElementById("latest");
  const controls = new Map();
  let frame = 0;

  const measured = new Map();
  let registered = new Map();
  let directTouch = false;
  let geometry = "";

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

  function updateTouchRects() {
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
    const changed = next !== geometry;
    geometry = next;
    return changed;
  }

  function sync() {
    frame = 0;
    const visible = new Set();
    const floating = latest.hidden ? null : (measured.get(latest) ?? (() => latest.getBoundingClientRect()))();
    let moved = false;
    for (const pane of panes) {
      const bounds = pane.getBoundingClientRect();
      if (!bounds.height || !bounds.width) continue;
      for (const row of pane.querySelectorAll(".tap-row")) {
        const box = row.getBoundingClientRect();
        const left = Math.max(0, bounds.left, box.left);
        const top = Math.max(0, bounds.top, box.top);
        const bottom = Math.min(innerHeight, bounds.bottom, box.bottom);
        let right = Math.min(innerWidth, bounds.right, box.right);
        if (pane.id === "messages" && floating && floating.top < bottom && floating.bottom > top) {
          right = Math.min(right, floating.left);
        }
        if (right <= left || bottom <= top) continue;
        visible.add(row);
        let button = controls.get(row);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.addEventListener("click", () => row.click());
          registry.append(button);
          controls.set(row, button);
        }
        const geometry = 'left:' + left + 'px;top:' + top + 'px;width:' + (right-left) + 'px;height:' + (bottom-top) + 'px';
        if (button.dataset.geometry !== geometry) {
          button.style.cssText = geometry;
          button.dataset.geometry = geometry;
          moved = true;
        }
        button.setAttribute("aria-label", row.innerText.trim());
        for (const attr of ["aria-pressed", "aria-expanded"]) {
          if (row.hasAttribute(attr)) button.setAttribute(attr, row.getAttribute(attr));
        }
      }
    }
    for (const [row, button] of controls) {
      if (visible.has(row)) continue;
      button.remove();
      controls.delete(row);
    }
    // The SDK watches hidden/disabled attributes, but not inline geometry.
    if (updateTouchRects() || moved) { registry.hidden = true; registry.hidden = false; }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync);
  }
  const mutations = new MutationObserver(schedule);
  for (const root of [document.querySelector(".masthead"), document.querySelector(".dashboard")]) {
    mutations.observe(root, {subtree:true, childList:true, attributes:true, attributeFilter:["hidden","aria-expanded","aria-pressed"]});
  }
  const resize = new ResizeObserver(schedule);
  panes.forEach(pane => resize.observe(pane));
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  (window.Zurface ?? window.Zeon)?.subscribe(({ touchMode }) => {
    if (directTouch === (touchMode === true)) return;
    directTouch = touchMode === true;
    schedule();
  });
  sync();
})();
