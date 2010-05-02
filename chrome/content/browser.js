/*
 * Replace a method with another one while still making the all too
 * popuplar kind of toSource + eval hack possible.
 */
function monkeyPatchMethod(obj, name, backupname, func) {
    obj[backupname] = obj[name];

    // Make the new method "look" like the old one.
    func.toSource = function () {
        return obj[backupname].toSource();
    };
    func.toString = function () {
        return obj[backupname].toString();
    };

    // If anyone should try to replace the method, replace the old one.
    obj.__defineGetter__(name, function () {
        return func;
    });
    obj.__defineSetter__(name, function (value) {
        obj[backupname] = value;
    });
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
    tabbrowser.tabContainer.addEventListener('TabSelect', this, false);
    tabbrowser.tabContainer.addEventListener('TabClose', this, false);

    // Monkey patch our way into the tabbrowser.
    monkeyPatchMethod(tabbrowser, "mTabProgressListener",
                      "BarTabProgressListener", this.TBmTabProgressListener);
    monkeyPatchMethod(tabbrowser, "addTab", "BarTabAddTab",
                      this.TBaddTab);
    monkeyPatchMethod(tabbrowser, "reloadTab", "BarTabReloadTab",
                      this.TBreloadTab);
    monkeyPatchMethod(tabbrowser, "reloadAllTabs", "BarTabReloadAllTabs",
                      this.TBreloadAllTabs);

    // Tab Mix Plus compatibility: It likes reusing blank tabs.  In doing
    // so it confuses tabs on the bar tab with blank ones.  Fix that.
    if (tabbrowser.isBlankBrowser) {
      this.TMPisBlankBrowser = tabbrowser.isBlankBrowser;
      tabbrowser.isBlankBrowser = function (aBrowser) {
        if (aBrowser.getAttribute("ontap") == "true") {
          return false;
        }
        return BarTap.TMPisBlankBrowser(aBrowser);
      };
    }

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


  /*** Replacement methods ***/

  /*
   * Hook into the tabbrowser's mTabProgressListener so that we can
   * replace its onStateChange method (see below).
   *
   * Note: 'this' refers to the tabbrowser.
   */
  TBmTabProgressListener: function(aTab, aBrowser, aStartsBlank) {
    var listener = this.BarTabProgressListener(aTab, aBrowser, aStartsBlank);
    monkeyPatchMethod(listener, "onStateChange", "oldStateChange",
                      BarTap.TBonStateChange);
    return listener;
  },

  /*
   * New implementation of the progress listener's onStateChange
   * method so that we can stop a tab from loading when necessary.
   *
   * Note: 'this' refers to the progress listener.
   */
  TBonStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    if (!aRequest)
      return;
    this.oldStateChange(aWebProgress, aRequest, aStateFlags, aStatus);

    const nsIWebProgressListener = Components.interfaces.nsIWebProgressListener;
    if (aStateFlags & nsIWebProgressListener.STATE_START
        && aStateFlags & nsIWebProgressListener.STATE_IS_NETWORK
        && !(aStateFlags & nsIWebProgressListener.STATE_RESTORING)
        && !this.mBlank) {
      BarTap.onTabStateChange(this.mTab);
    }
  },

  /*
   * Hook into the 'addTab' method so that we can mark tabs that are
   * opened in the background.  Whether or not they're going to be
   * loaded will then be decided by the progress listener.
   *
   * Note: 'this' refers to the tabbrowser.
   */
  TBaddTab: function(aURI) {
    // We need to mark the tab before the browser.loadURI*() is
    // called.  We can do that by registering a TabOpen event
    // handler which is registered inline so that it has access to
    // this method's arguments.
    var blank = !aURI || (aURI == "about:blank");
    if (!blank) {
      let referrer = arguments[1];
      if (arguments.length == 2
          && typeof arguments[1] == "object"
          && !(arguments[1] instanceof Ci.nsIURI)) {
        referrer = arguments[1].referrerURI;
      }

      let self = this;
      this.tabContainer.addEventListener("TabOpen", function (aEvent) {
          self.tabContainer.removeEventListener("TabOpen", arguments.callee, false);
          var tab = aEvent.originalTarget;
          BarTap.hookNewTab(self, tab, aURI, referrer);
      }, false);
    }

    return this.BarTabAddTab.apply(this, arguments);
  },

  /*
   * When the user wants one or all tabs to reload, do the right
   * thing in case the tab isn't loaded yet.
   * 
   * Note: 'this' refers to the tabbrowser.
   */
  TBreloadTab: function(aTab) {
    if (aTab.getAttribute("ontap") == "true") {
      BarTap.loadTabContents(aTab);
      if (!aTab.selected) {
        this.BarTapTimer.startTimer(aTab);
      }
      return;
    }
    aTab.linkedBrowser.reload();
  },

  TBreloadAllTabs: function() {
    for (var i = 0; i < this.mTabs.length; i++) {
      try {
        this.reloadTab(this.mTabs[i]);
      } catch (e) {
        // ignore failure to reload so others will be reloaded
      }
    }
  },


  /*** Core machinery ***/

  /*
   * Listen to the 'SSTabRestoring' event from the nsISessionStore
   * service and put a marker on restored tabs so that 'onTabStateChange'
   * can take the appropriate action.
   */
  onTabRestoring: function(event) {
    if (!this.mPrefs.getBoolPref("extensions.bartap.tapRestoredTabs")) {
      return;
    }
    let tab = event.originalTarget;
    if (tab.selected) {
      return;
    }
    tab.setAttribute("ontap", "true");
    tab.linkedBrowser.setAttribute("ontap", "true");
  },

  /*
   * Called when a tab is opened with a new URI (e.g. by opening a
   * link or bookmark in a new tab.)  Depending on the user's
   * settings, this either puts the tab on hold or hooks up the timer.
   */
  hookNewTab: function(aTabBrowser, aTab, aURI, aReferrerURI) {
    if (!aURI) {
      return;
    }
    if (this.mPrefs.getBoolPref("extensions.bartap.tapBackgroundTabs")) {
      // Create a fake history entry from the URI information.  That
      // way the nsISessionStore service knows how to persist an
      // unloaded tab created in the background.
      let entry = Cc["@mozilla.org/browser/session-history-entry;1"]
                  .createInstance(Ci.nsISHEntry);
      entry.setURI(makeURI(aURI));
      entry.loadType = Ci.nsIDocShellLoadInfo.loadHistory;
      if (aReferrerURI) {
        entry.referrerURI = aReferrerURI;
      }

      // Ensure a new document identifier (Firefox 3.7)
      if (typeof entry.setUniqueDocIdentifier === "function") {
        entry.setUniqueDocIdentifier();
      }
      let history = aTab.linkedBrowser.webNavigation.sessionHistory;
      history.QueryInterface(Ci.nsISHistoryInternal);
      history.addEntry(entry, true);

      aTab.setAttribute("ontap", "true");
      aTab.linkedBrowser.setAttribute("ontap", "true");
    } else if (this.mPrefs.getBoolPref("extensions.bartap.tapAfterTimeout")) {
      aTabBrowser.BarTapTimer.startTimer(aTab);
    }
  },

  /*
   * Called when the browser wants to load stuff into a tab.  If the
   * tab has been placed on tap, stop the loading and defer to an
   * event listener.  Returns true of the tab has been tapped.
   */
  onTabStateChange: function(tab) {
    if (tab.getAttribute("ontap") != "true") {
      return false;
    }

    var browser = tab.linkedBrowser;
    var history = browser.webNavigation.sessionHistory;
    var gotouri;
    var loadHandler;

    if (history.count) {
      // Likely a restored tab, try loading from history.
      let gotoindex = history.requestedIndex;
      if (gotoindex == -1) {
        gotoindex = history.index;
      }
      gotouri = history.getEntryAtIndex(gotoindex, false).URI;
      loadHandler = this.loadHandlerFromHistory(gotoindex);
    } else if (browser.userTypedValue) {
      gotouri = makeURI(browser.userTypedValue);
      loadHandler = this.loadFromUserValue;
      window.setTimeout(this.setTitleAndIcon, 0, tab, gotouri);
    } else {
      return false;
    }

    // Check whether this URI is on the white list
    if (gotouri) {
      try {
        if (this.getHostWhitelist().indexOf(gotouri.host) != -1) {
          tab.removeAttribute("ontap");
          browser.removeAttribute("ontap");
          return false;
        }
      } catch(ex) {
        // Most likely gotouri.host failed.  No matter, just carry on.
      }
    }

    // The URI isn't on the white list, so let's defer loading the tab
    // to an event handler.
    tab.removeAttribute("busy");
    browser.stop();
    if (gotouri) {
      window.setTimeout(this.setTitleAndIcon, 0, tab, gotouri);
    }
    browser.addEventListener("BarTapLoad", loadHandler, false);
    return true;
  },

  loadHandlerFromHistory: function(gotoindex) {
    return function(aEvent) {
      var browser = aEvent.target;
      browser.removeEventListener("BarTapLoad", arguments.callee, false);
      browser.webNavigation.gotoIndex(gotoindex);
    };
  },

  loadFromUserValue: function(aEvent) {
    var browser = aEvent.target;
    browser.removeEventListener("BarTapLoad", arguments.callee, false);
    browser.loadURI(browser.userTypedValue);
  },

  onTabSelect: function(event) {
    var tab = event.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
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
    // Remove marker so that we can proceed loading the browser
    // contents or, in case of about:blank where there's no event
    // handler, continue to function normally.
    tab.removeAttribute("ontap");
    tab.linkedBrowser.removeAttribute("ontap");

    let event = document.createEvent("Event");
    event.initEvent("BarTapLoad", true, true);
    tab.linkedBrowser.dispatchEvent(event);
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
   * Set a tab's title and favicon given a URI, e.g. by querying the
   * history service.
   */
  setTitleAndIcon: function(aTab, aURI) {
    // See if we have title, favicon in stock for it. This should definitely
    // work for restored tabs as they're in the history database.
    let info = BarTap.getInfoFromHistory(aURI);
    if (info) {
      // Firefox cripples nsINavHistoryService entries for fragment links.
      // See https://bugzilla.mozilla.org/show_bug.cgi?id=420605
      // Try to work around that by stripping the fragment from the URI.
      let anchor = aURI.path.indexOf('#');
      if (!info.icon && (anchor != -1)) {
        let uri = aURI.clone();
        uri.path = uri.path.substr(0, anchor);
        let anchorinfo = BarTap.getInfoFromHistory(uri);
        if (anchorinfo) {
          info = anchorinfo;
        }
      }
      aTab.setAttribute("image", info.icon);
      aTab.label = info.title;
      return;
    }

    try {
      // Set a meaningful part of the URI as tab label
      let hostPort = aURI.hostPort;
      let path = aURI.path;
      if (hostPort.substr(0, 4) == "www.") {
        hostPort = hostPort.substr(4);
      }
      if (path == "/") {
        path = "";
      }
      aTab.label = hostPort + path;
    } catch (ex) {
      // Most likely aURI.hostPort and aURI.path failed.
      // Let's handle this gracefully.
      aTab.label = aURI.spec;
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
