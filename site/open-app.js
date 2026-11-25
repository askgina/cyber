// Record pages are plain HTML for search engines and agents. A person with JavaScript gets the
// app instead, with the record open: "/#e-<id>" is rewritten by the app to "/incidents/<id>".
(() => {
  const m = location.pathname.match(/^\/incidents\/([^/]+)\/?$/);
  if (m) location.replace("/" + location.search + "#e-" + m[1]);
})();
