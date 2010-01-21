bartap.onFirefoxLoad = function(event) {
  document.getElementById("contentAreaContextMenu")
          .addEventListener("popupshowing", function (e){ bartap.showFirefoxContextMenu(e); }, false);
};

bartap.showFirefoxContextMenu = function(event) {
  // show or hide the menuitem based on what the context menu is on
  document.getElementById("context-bartap").hidden = gContextMenu.onImage;
};

window.addEventListener("load", bartap.onFirefoxLoad, false);
