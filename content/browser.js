Components.utils.import("resource://bartab/prototypes.js");

// Initialize BarTab as soon as possible while ensuring that XBL
// constructors have already been called.  That means we can't listen
// to the DOMContentLoaded event.
window.addEventListener("load", function() {
  window.removeEventListener("load", arguments.callee, false);
  BarTabUtils.migratePrefs();
  var tabbrowser = document.getElementById("content");
  (new BarTabHandler).init(tabbrowser);
}, false);
