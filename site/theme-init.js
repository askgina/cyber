(() => {
  const root = document.documentElement
  const key = "bl-theme"

  // Read the preference in the head, before the browser paints the page.
  try {
    if (localStorage.getItem(key) === "dark") root.dataset.theme = "dark"
  } catch {
    // Storage can be blocked. The theme still works for this page.
  }

  function sync() {
    const on = root.dataset.theme === "dark"
    for (const button of document.querySelectorAll(".t-theme")) {
      button.setAttribute("aria-pressed", String(on))
      button.setAttribute("aria-label", on ? "Light mode" : "Dark mode")
    }
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = on ? "#0a0a0a" : "#000443"
    }
  }

  sync()
  if (document.readyState === "loading") {
    // Keep parser-added controls in sync even if the page paints before DOMContentLoaded.
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    document.addEventListener("DOMContentLoaded", () => {
      observer.disconnect()
      sync()
    }, { once: true })
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(".t-theme")) return
    const dark = root.dataset.theme !== "dark"
    if (dark) root.dataset.theme = "dark"
    else delete root.dataset.theme
    try {
      localStorage.setItem(key, dark ? "dark" : "light")
    } catch {
      // Keep the page's current theme even when it cannot be saved.
    }
    sync()
  })
})()
