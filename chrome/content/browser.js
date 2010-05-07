/*
 * Firefox 3.5 doesn't have these handy functions for defining lazy getters.
 */
if (typeof XPCOMUtils.defineLazyGetter !== "function") {
  XPCOMUtils.defineLazyGetter = function(aObject, aName, aLambda) {
    aObject.__defineGetter__(aName, function() {
      delete aObject[aName];
      return aObject[aName] = aLambda.apply(aObject);
    });
  };
}

if (typeof XPCOMUtils.defineLazyServiceGetter !== "function") {
  XPCOMUtils.defineLazyServiceGetter = function(aObject, aName,
                                                aContract, aInterfaceName) {
    XPCOMUtils.defineLazyGetter(aObject, aName, function XPCU_serviceLambda() {
      return Cc[aContract].getService(Ci[aInterfaceName]);
    });
  };
}


var BarTap = {

  handleEvent: function(event) {
    switch (event.type) {
    case 'DOMContentLoaded':
      this.init();
      return;
    case 'SSTabRestoring':
      this.onTabRestoring(event);
      return;
    case 'TabOpen':
      this.onTabOpen(event);
      return;
    case 'TabSelect':
      this.onTabSelect(event);
      return;
    case 'TabClose':
      this.onTabClose(event);
      return;
    case 'popupshowing':
      this.onPopupShowing(event);
      return;
    }
  },

  init: function() {
    window.removeEventListener("DOMContentLoaded", this, false);

    this.l10n = document.getElementById('bartap-strings');

    let tabbrowser = document.getElementById("content");
    this.initTabBrowser(tabbrowser);
  },

  /*
   * Initialize the tab browser.  This is deliberately its own method
   * so that extensions that have other tabbrowsers can call it.
   */
  initTabBrowser: function(tabbrowser) {
    tabbrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
    tabbrowser.tabContainer.addEventListener('TabOpen', this, false);
    tabbrowser.tabContainer.addEventListener('TabSelect', this, false);
    tabbrowser.tabContainer.addEventListener('TabClose', this, false);

    // Initialize timer
    tabbrowser.BarTapTimer = new BarTapTimer(tabbrowser);

    // We need an event listener for the context menu so that we can
    // adjust the label of the whitelist menu item
    let popup = tabbrowser.tabContainer.contextMenu;
    if (!popup) {
      // In Firefox <3.7, the tab context menu lives inside the tabbrowser.
      popup = document.getAnonymousElementByAttribute(
          tabbrowser, "anonid", "tabContextMenu");
      let before = document.getAnonymousElementByAttribute(
          tabbrowser, "id", "context_openTabInWindow");
      for each (let menuitemid in ["context_putOnTap",
                                   "context_putAllOnTapBut",
                                   "context_neverPutOnTap",
                                   "context_tapSeparator"]) {
        let menuitem = document.getElementById(menuitemid);
        popup.insertBefore(menuitem, before);
      }
    }
    popup.addEventListener('popupshowing', this, false);
  },


  /*** Core machinery ***/

  /*
   * Hook into newly opened tabs if the user wants to prevent tabs
   * opened in the background from loading.  (If this tab ends up not
   * being in the background after all, 'onTabSelect' will take care
   * of loading the tab.)
   */
  onTabOpen: function(aEvent) {
    var tab = aEvent.originalTarget;
    if (!tab.selected
        && this.mPrefs.getBoolPref("extensions.bartap.tapBackgroundTabs")) {
      tab.setAttribute("ontap", "true");
      (new BarTabWebNavigation()).hook(tab);
    } else if (this.mPrefs.getBoolPref("extensions.bartap.tapAfterTimeout")) {
      this.getTabBrowserForTab(tab).BarTapTimer.startTimer(tab);
    }
  },

  /*
   * Listen to the 'SSTabRestoring' event from the nsISessionStore
   * service and hook into restored tabs if the user wants to prevent
   * restored tabs from loading.
   */
  onTabRestoring: function(event) {
    if (!this.mPrefs.getBoolPref("extensions.bartap.tapRestoredTabs")) {
      return;
    }
    let tab = event.originalTarget;
    if (tab.selected || tab.getAttribute("ontap") == "true") {
      return;
    }
    tab.setAttribute("ontap", "true");
    (new BarTabWebNavigation()).hook(tab);
  },

  onTabSelect: function(event) {
    var tab = event.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
      return;
    }

    // Always load a blank page immediately
    let uri = tab.linkedBrowser.webNavigation.currentURI;
    if (!uri || (uri.spec == "about:blank")) {
      this.loadTabContents(tab);
      return;      
    }

    switch (this.mPrefs.getIntPref("extensions.bartap.loadOnSelect")) {
    case 1:
      // Load immediately
      this.loadTabContents(tab);
      return;
    case 2:
      // Load after delay
      let delay = this.mPrefs.getIntPref("extensions.bartap.loadOnSelectDelay");
      window.setTimeout(function() {
          if (tab.selected) {
            BarTap.loadTabContents(tab);
          }
        }, delay);
      return;
    case 0:
      // Ask whether to load
      let tabbrowser = this.getTabBrowserForTab(tab);
      let box = tabbrowser.getNotificationBox(tab.linkedBrowser);
      let label = this.l10n.getString("loadNotification");
      let buttons = [{label: this.l10n.getString("loadButton"),
                      accessKey: this.l10n.getString("loadButton.accesskey"),
                      callback: function() {BarTap.loadTabContents(tab);}}];
      let bar = box.appendNotification(label, 'bartap-load', "",
                                       box.PRIORITY_INFO_MEDIUM, buttons);
      return;
    }
  },

  loadTabContents: function(tab) {
    tab.removeAttribute("ontap");
    tab.linkedBrowser.webNavigation.resume();
  },

  onTabClose: function(event) {
    if (!this.mPrefs.getBoolPref("extensions.bartap.findClosestUntappedTab")) {
      return;
    }
    let tab = event.originalTarget;
    if (!tab.selected) {
      return;
    }
    let tabbrowser = this.getTabBrowserForTab(tab);
    let activeTab = this.findClosestUntappedTab(tab, tabbrowser);
    if (activeTab) {
      tabbrowser.selectedTab = activeTab;
    }
  },


  /*** Handlers for commands (e.g. context menu items) ***/

  onPopupShowing: function(event) {
    var tab =  document.popupNode.localName == "tab" ?
          document.popupNode : gBrowser.selectedTab;

    var neverputontap = document.getElementById("context_neverPutOnTap");
    var putontap = document.getElementById("context_putOnTap");

    if (tab.getAttribute("ontap") == "true") {
      putontap.setAttribute("disabled", "true");

      // TODO even though the tab is unloaded one still might want to
      // put the host on the whitelist.
      neverputontap.setAttribute("hidden", "true");
      return;
    }

    let host;
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch (ex) {
      // Most likely uri.host doesn't exist which probably means whitelisting
      // doesn't make sense on this tab.  Don't show the menu item
      neverputontap.setAttribute("hidden", "true");
      putontap.removeAttribute("disabled");
      return;
    }

    let label = this.l10n.getFormattedString('neverPutOnTap', [host]);
    neverputontap.setAttribute("label", label);
    neverputontap.removeAttribute("hidden");
    if (this.getHostWhitelist().indexOf(host) == -1) {
      neverputontap.removeAttribute("checked");
      putontap.removeAttribute("disabled");
    } else {
      neverputontap.setAttribute("checked", "true");
      putontap.setAttribute("disabled", "true");
    }
  },

  putOnTap: function(aTab, aTabBrowser) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (aTab.getAttribute("ontap") == "true") {
      return;
    }
    try {
      let uri = aTab.linkedBrowser.currentURI;
      if (this.getHostWhitelist().indexOf(uri.host) != -1) {
        return;
      }
    } catch(ex) {
      // Most likely uri.host failed.  No matter, just carry on.
    }

    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    // Make sure that we're not on this tab.  If we are, find the
    // closest tab that isn't on the bar tab.
    if (aTab.selected) {
      let activeTab = this.findClosestUntappedTab(aTab, aTabBrowser);
      if (activeTab) {
        aTabBrowser.selectedTab = activeTab;
      }
    }

    var sessionstore = this.mSessionStore;
    var state = sessionstore.getTabState(aTab);
    var newtab = aTabBrowser.addTab();

    // The user might not have the 'extensions.bartap.tapRestoredTabs'
    // preference enabled but still wants to put this tab on the bar tab.
    // That's why we need to make sure this attribute exists before
    // restoring the tab state.
    newtab.setAttribute("ontap", "true");
    newtab.linkedBrowser.setAttribute("ontap", "true");
    sessionstore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    aTabBrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (aTabBrowser.treeStyleTab) {
      let children = aTabBrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
          aTabBrowser.treeStyleTab.attachTabTo(
              aChild, newtab, {dontAnimate: true});
        });
    }

    // Close the original tab.  We're taking the long way round to ensure the
    // nsISessionStore service won't save this in the recently closed tabs.
    aTabBrowser._endRemoveTab(aTabBrowser._beginRemoveTab(aTab, true, null, false));
  },

  putAllOnTapBut: function(aTab, aTabBrowser) {
    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (aTabBrowser.selectedTab != aTab) {
      aTabBrowser.selectedTab = aTab;
    }

    // putOnTap() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    var tabs = [];
    for (let i = 0; i < aTabBrowser.mTabs.length; i++) {
      tabs.push(aTabBrowser.mTabs[i]);
    }
    var self = this;
    tabs.forEach(function(tab) {
        if (tab != aTab) {
          self.putOnTap(tab, aTabBrowser);
        }
      });
  },

  toggleHostWhitelist: function(tab, tabbrowser) {
    // TODO the tab could also be tapped (so uri is about:blank)
    var uri = tab.linkedBrowser.currentURI;
    try {
      var host = uri.host;
    } catch(ex) {
      // Most likely uri.host doesn't exist.  Ignore then.
      return;
    }

    let whitelist = this.getHostWhitelist();
    let index = whitelist.indexOf(host);
    if (index == -1) {
      whitelist.push(host);
    } else {
      whitelist.splice(index, 1);
    }

    this.setHostWhitelist(whitelist);
  },


  /*** Helper functions ***/

  /*
   * In relation to a given tab, find the closest tab that is loaded.
   * Note: if there's no such tab available, this will return unloaded
   * tabs as a last resort.
   */
  findClosestUntappedTab: function(aTab, aTabBrowser) {
    // Shortcut: if this is the only tab available, we're not going to
    // find another active one, are we...
    if (aTabBrowser.mTabs.length == 1) {
      return null;
    }

    // The most obvious choice would be the owner tab, if it's active.
    if (aTab.owner && aTab.owner.getAttribute("ontap") != "true") {
      return aTab.owner;
    }

    // Otherwise walk the tab list and see if we can find an active one.
    let i = 1;
    while ((aTab._tPos - i >= 0) ||
           (aTab._tPos + i < aTabBrowser.mTabs.length)) {
      if (aTab._tPos + i < aTabBrowser.mTabs.length) {
        if (aTabBrowser.mTabs[aTab._tPos+i].getAttribute("ontap") != "true") {
          return aTabBrowser.mTabs[aTab._tPos+i];
        }
      }
      if (aTab._tPos - i >= 0) {
        if (aTabBrowser.mTabs[aTab._tPos-i].getAttribute("ontap") != "true") {
          return aTabBrowser.mTabs[aTab._tPos-i];
        }
      }
      i++;
    }

    // Fallback: there isn't an active tab available, so we're going
    // to have to nominate a non-active one.
    if (aTab.owner) {
      return aTab.owner;
    }
    if (aTab.nextSibling) {
      return aTab.nextSibling;
    }
    return aTab.previousSibling;
  },

  /*
   * Find and set the tab's favicon for a given URI.
   */
  setIcon: function(aTab, aURI) {
    try {
      let iconURI = BarTap.mFavicon.getFaviconForPage(aURI);
      aTab.setAttribute("image", iconURI.spec);
    } catch (ex) {
      // No favicon found.  Perhaps it's a URL with an anchor?
      // Firefox doesn't always store favicons for those.
      // See https://bugzilla.mozilla.org/show_bug.cgi?id=420605
      aURI = BarTap.stripFragmentFromURI(aURI);
      if (aURI) {
        BarTap.setIcon(aTab, aURI);
      }
    }
  },

  /*
   * Set a tab's title and favicon given a URI by querying the history
   * service.
   */
  setTitleAndIcon: function(aTab, aURI) {
    // See if we have title, favicon in stock for it. This should definitely
    // work for restored tabs as they're in the history database.
    let info = BarTap.getInfoFromHistory(aURI);
    if (!info) {
      aTab.label = BarTap.titleFromURI(aURI);
      return;
    }
    // Firefox cripples nsINavHistoryService entries for fragment links.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=503832
    // Try to work around that by stripping the fragment from the URI.
    if (!info.icon) {
      let uri = BarTap.stripFragmentFromURI(aURI);
      if (uri) {
        let anchorinfo = BarTap.getInfoFromHistory(uri);
        if (anchorinfo) {
          info = anchorinfo;
        }
      }
    }
    aTab.setAttribute("image", info.icon);
    aTab.label = info.title;
  },

  /*
   * Strip the fragment from a URI.  Returns a new URI object, or null
   * if the URI didn't contain a fragment.
   */
  stripFragmentFromURI: function(aURI) {
    var anchor = aURI.path.indexOf('#');
    if (anchor == -1) {
      return null;
    }
    let uri = aURI.clone();
    uri.path = uri.path.substr(0, anchor);
    return uri;
  },

  /*
   * Derive a title from a URI by stripping the protocol and potentially
   * "www.", so "http://www.mozilla.org" would become "mozilla.org".
   */
  titleFromURI: function(aURI) {
    try {
      let hostPort = aURI.hostPort;
      let path = aURI.path;
      if (hostPort.substr(0, 4) == "www.") {
        hostPort = hostPort.substr(4);
      }
      if (path == "/") {
        path = "";
      }
      return hostPort + path;
    } catch (ex) {
      // Most likely aURI.hostPort and aURI.path failed.
      // Let's handle this gracefully.
      return aURI.spec;
    }
  },

  /*
   * Get information about a URI from the history service,
   * e.g. title, favicon, ...
   */
  getInfoFromHistory: function(aURI) {
    var history = this.mHistory;
    var options = history.getNewQueryOptions();
    options.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;
    options.maxResults = 1;

    var query = history.getNewQuery();
    query.uri = aURI;

    var result = history.executeQuery(query, options);
    result.root.containerOpen = true;

    if (!result.root.childCount) {
      return null;
    }
    return result.root.getChild(0);
  },

  getTabBrowserForTab: function(tab) {
    // Fuzzy test for FFX 3.7 where the tabbar lives outside the tabbrowser.
    if (tab.parentNode.tabbrowser) {
      return tab.parentNode.tabbrowser;
    }
    while (tab.localName != 'tabbrowser') {
      tab = tab.parentNode;
    }
    return tab;
  },

  /*
   * Check whether a URI is on the white list.
   */
  whiteListed: function(aURI) {
    try {
      return (this.getHostWhitelist().indexOf(aURI.host) != -1);
    } catch(ex) {
      // Most likely gotouri.host failed, so it isn't on the white list.
      return false;
    }
  },

  /*
   * It might seem more elegant to use a getter & setter here so you could
   * just use this.hostWhiteList or similar.  However, that would suggest
   * this.hostWhiteList would always return the same array and that
   * mutations to it would be persisted.  Both are not the case.
   */

  getHostWhitelist: function() {
    var whitelist = this.mPrefs.getCharPref("extensions.bartap.hostWhitelist");
    if (!whitelist) {
      return [];
    }
    return whitelist.split(";");
  },

  setHostWhitelist: function(whitelist) {
    this.mPrefs.setCharPref("extensions.bartap.hostWhitelist",
                            whitelist.join(";"));
  }

};

/*
 * Lazy getters for XPCOM services.  This is in analogy to
 * Services.jsm which is available in Firefox 3.7.
 */
XPCOMUtils.defineLazyGetter(BarTap, "mPrefs", function () {
  return Cc["@mozilla.org/preferences-service;1"]
         .getService(Ci.nsIPrefService)
         .QueryInterface(Ci.nsIPrefBranch2);
});
XPCOMUtils.defineLazyServiceGetter(BarTap, "mSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(BarTap, "mHistory",
                                   "@mozilla.org/browser/nav-history-service;1",
                                   "nsINavHistoryService");
XPCOMUtils.defineLazyServiceGetter(BarTap, "mFavicon",
                                   "@mozilla.org/browser/favicon-service;1",
                                   "nsIFaviconService");


// Initialize BarTap as soon as possible.
window.addEventListener("DOMContentLoaded", BarTap, false);


/*
 * A timer that keeps track of how long ago each tab was last visited.
 * If that time reaches a user-defined value, it unloads the tab in
 * question.  (The actual implementation works differently.  It uses
 * setTimeout, of course).
 */
function BarTapTimer(tabbrowser) {
  this.tabbrowser = tabbrowser;
  tabbrowser.tabContainer.addEventListener('TabSelect', this, false);
  tabbrowser.tabContainer.addEventListener('TabClose', this, false);

  this.previousTab = null;
  this.selectedTab = tabbrowser.selectedTab;
}

BarTapTimer.prototype = {

  handleEvent: function(event) {
    switch (event.type) {
    case 'TabSelect':
      this.onTabSelect(event);
      return;
    case 'TabClose':
      this.onTabClose(event);
      return;
    }
  },

  onTabClose: function(event) {
    this.clearTimer(event.originalTarget);
    if (event.originalTarget == this.selectedTab) {
      this.selectedTab = null;
    };
    if (event.originalTarget == this.previousTab) {
      this.previousTab = null;
    };
  },

  onTabSelect: function(event) {
    this.previousTab = this.selectedTab;
    this.selectedTab = event.originalTarget;

    if (this.previousTab) {
      /* The previous tab may not be available because it has been closed */
      this.startTimer(this.previousTab);
    }
    this.clearTimer(this.selectedTab);
  },

  startTimer: function(aTab) {
    if (!BarTap.mPrefs.getBoolPref("extensions.bartap.tapAfterTimeout")) {
      return;
    }
    if (aTab.getAttribute("ontap") == "true") {
      return;
    }

    if (aTab._barTapTimer) {
      this.clearTimer(aTab);
    }
    let secs = BarTap.mPrefs.getIntPref("extensions.bartap.timeoutValue")
             * BarTap.mPrefs.getIntPref("extensions.bartap.timeoutUnit");
    // Allow 'this' to leak into the inline function
    var self = this;
    aTab._barTapTimer = window.setTimeout(function() {
        // The timer will be removed automatically since
        // BarTap.putOnTab will close and replace the original tab.
        BarTap.putOnTap(aTab, self.tabbrowser);
      }, secs*1000);
  },

  clearTimer: function(aTab) {
    window.clearTimeout(aTab._barTapTimer);
    aTab._barTapTimer = null;
  }
}


function BarTabWebNavigation () {}
BarTabWebNavigation.prototype = {

    /*
     * Install ourself as browser's webNavigation.  This needs to be
     * passed the tab object (rather than just its associated browser
     * object) because we need to be able to read and change tab's
     * 'ontap' attribute.
     */
    hook: function (aTab) {
        this._tab = aTab;
        this._original = aTab.linkedBrowser.webNavigation;

        var self = this;
        aTab.linkedBrowser.__defineGetter__('webNavigation', function () {
            return self;
        });
    },

    /*
     * Restore the browser's original webNavigation.
     */
    unhook: function () {
        if (this._tab.linkedBrowser.webNavigation === this) {
            // This will delete the instance getter for 'webNavigation',
            // thus revealing the original implementation.
            delete this._tab.linkedBrowser.webNavigation;
        }
        delete this._original;
        delete this._tab;
    },

    /*
     * This will be replaced with either _resumeGotoIndex or _resumeLoadURI,
     * unless it's a blank tab.  For the latter case we make sure we'll
     * unhook ourselves.
     */
    resume: function () {
        this.unhook();
    },


    /*** Hook into gotoIndex() ***/

    gotoIndex: function (aIndex) {
        if (this._tab.getAttribute("ontap") == "true") {
            return this._pauseGotoIndex(aIndex);
        }
        return this._original.gotoIndex(aIndex);
    },

    _pauseGotoIndex: function (aIndex) {
        var history = this._original.sessionHistory;
        var entry = history.getEntryAtIndex(aIndex, false);
        if (BarTap.whiteListed(entry.URI)) {
            this._tab.removeAttribute("ontap");
            return this._original.gotoIndex(aIndex);
        }

        this._tab.removeAttribute("busy");
        this._tab.label = entry.title;
        window.setTimeout(BarTap.setIcon, 0, this._tab, entry.URI);
        this._gotoindex = aIndex;
        this._currenturi = entry.URI;
        this._referringuri = entry.referrerURI;
        this.resume = this._resumeGotoIndex;
    },

    _resumeGotoIndex: function () {
        var index = this._gotoindex;
        var original = this._original;
        delete this._gotoindex;
        delete this._currenturi;
        delete this._referringuri;
        this.unhook();
        return original.gotoIndex(index);
    },


    /*** Hook into loadURI() ***/

    loadURI: function (aURI) {
        // We allow about:blank to load
        if (aURI
            && (aURI != "about:blank")
            && (this._tab.getAttribute("ontap") == "true")) {
            return this._pauseLoadURI.apply(this, arguments);
        }
        return this._original.loadURI.apply(this._original, arguments);
    },

    _pauseLoadURI: function (aURI, aLoadFlags, aReferrer) {
        var uri = makeURI(aURI);
        if (BarTap.whiteListed(uri)) {
            let original = this._original;
            this._tab.removeAttribute("ontap");
            this.unhook();
            return original.loadURI.apply(original, arguments);
        }

        this._tab.removeAttribute("busy");
        window.setTimeout(BarTap.setTitleAndIcon, 0, this._tab, uri);
        this._loaduri_args = arguments;
        this._currenturi = makeURI(aURI);
        if (aReferrer instanceof Ci.nsIURI) {
            this._referringuri = aReferrer.clone();
        }
        this.resume = this._resumeLoadURI;
    },

    _resumeLoadURI: function () {
        var args = this._loaduri_args;
        var original = this._original;
        delete this._loaduri_args;
        delete this._currenturi;
        delete this._referringuri;
        this.unhook();
        return original.loadURI.apply(original, args);
    },


    /*** Behaviour changed for unloaded tabs. ***/

    get currentURI() {
        if (this._currenturi) {
            return this._currenturi.clone();
        }
        return this._original.currentURI;
    },
    get referringURI() {
        if (this._referringuri) {
            return this._referringuri.clone();
        }
        return this._original.currentURI;
    },

    reload: function(aReloadFlags) {
        if (this._tab.getAttribute("ontap") == "true") {
            this._tab.removeAttribute("ontap");
            //TODO should we patch aReloadFlags into this._loaduri_args?
            return this.resume();
        }
        return this._original.reload(aReloadFlags);
    },

    QueryInterface: function(aIID) {
        if (Ci.nsISupports.equals(aIID) || Ci.nsIWebNavigation.equals(aIID)) {
            return this;
        }
        return this._original.QueryInterface(aIID);
    },


    /*** These methods and properties are simply passed through. ***/

    goBack: function () {
        return this._original.goBack();
    },
    goForward: function () {
        return this._original.goForward();
    },
    stop: function(aStopFlags) {
        return this._original.stop(aStopFlags);
    },
    get canGoBack() {
        return this._original.canGoBack;
    },
    get canGoForward() {
        return this._original.canGoForward;
    },
    get document() {
        return this._original.document;
    },
    get sessionHistory() {
        return this._original.sessionHistory;
    }
};
