function makeURI(aURL, aOriginCharset, aBaseURI) {
  var ioService = Components.classes["@mozilla.org/network/io-service;1"]
                  .getService(Components.interfaces.nsIIOService);
  return ioService.newURI(aURL, aOriginCharset, aBaseURI);
}

var BarTabPreferences = {

  prefs: Components.classes["@mozilla.org/preferences-service;1"]
         .getService(Components.interfaces.nsIPrefBranch)
         .QueryInterface(Components.interfaces.nsIPrefBranch2),

  init: function() {
    this.prefs.addObserver("extensions.bartap.hostWhitelist", this, false);
    this.onTimeoutChange();
    this.onLoadChange();
    this.updateHostWhitelist();
  },

  destroy: function() {
    this.prefs.removeObserver("extensions.bartap.hostWhitelist", this);
  },

  QueryInterface: function(aIID) {
    if (aIID.equals(Components.interfaces.nsIObserver) ||
        aIID.equals(Components.interfaces.nsISupports)) {
      return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  },


  /* Toggle visibility for timeout and load delay settings. */

  onTimeoutChange: function() {
    var menuitem = document.getElementById('tapAfterTimeout').selectedItem;
    var timerWidgets = document.getElementById('timerWidgets');
    var visibility = (menuitem.value == "true") ? 'visible' : 'hidden';
    timerWidgets.style.visibility = visibility;
  },

  onLoadChange: function() {
    var menuitem = document.getElementById('loadOnSelect').selectedItem;
    var delayWidgets = document.getElementById('delayWidgets');
    var visibility = (menuitem.value == "2") ? 'visible' : 'hidden';
    delayWidgets.style.visibility = visibility;
  },

  /* Add to and remove hosts from whitelist */

  updateHostWhitelist: function() {
    var list = document.getElementById("hostWhitelist");
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
 
    var whitelist = this.getHostWhitelist();
    whitelist.forEach(function(host) {
        let row = document.createElement("listitem");
        row.setAttribute("label", host);
        list.appendChild(row);
      });
  },

  hostSelected: function() {
    var removeButton = document.getElementById("hostWhitelistRemove");
    var list = document.getElementById("hostWhitelist");
    if (list.selectedItem) {
      removeButton.setAttribute("disabled", "false");
    } else {
      removeButton.setAttribute("disabled", "true");
    }
  },

  removeHost: function() {
    var list = document.getElementById("hostWhitelist");
    var host = list.selectedItem.getAttribute("label");
    
    var whitelist = this.getHostWhitelist();
    var index = whitelist.indexOf(host);
    if (index == -1) {
      return;
    }

    whitelist.splice(index, 1);
    this.setHostWhitelist(whitelist);
  },

  addHost: function() {
    var textbox = document.getElementById("hostWhitelistNewHost");
    var whitelist = this.getHostWhitelist();
    var host = textbox.value.trim();

    if (!host) {
      return;
    }

    // Convert whole URLs to hostnames
    if ((host.substr(0, 7) == "http://")
        || (host.substr(0, 8) == "https://")) {
      try {
        host = makeURI(host).host;
      } catch(ex) {
        // Ignore
      }
    }

    // Sort out duplicates.
    if (whitelist.indexOf(host) != -1) {
      return;
    }

    // TODO What happens if 'host' contains a semicolon?
    whitelist.push(host);
    this.setHostWhitelist(whitelist);
    textbox.value = "";
  },

  onNewHostKeyPress: function(event) {
    switch (event.keyCode) {
    case event.DOM_VK_ENTER:
    case event.DOM_VK_RETURN:
      this.addHost();
    }
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "nsPref:changed") {
      return;
    }
    this.updateHostWhitelist();
  },


  /* For now these methods are duplicated from browser.js :\ */

  getHostWhitelist: function() {
    var whitelist = this.prefs.getCharPref("extensions.bartap.hostWhitelist");
    if (!whitelist) {
      return [];
    }
    return whitelist.split(";");
  },

  setHostWhitelist: function(whitelist) {
    this.prefs.setCharPref("extensions.bartap.hostWhitelist",
                           whitelist.join(";"));
  }
};
