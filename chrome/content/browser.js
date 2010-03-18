var BarTap = {

  mPrefs: Components.classes['@mozilla.org/preferences-service;1']
          .getService(Components.interfaces.nsIPrefService).getBranch(null),

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
    case 'popupshowing':
      this.onPopupShowing(event);
      return;
    }
  },

  init: function() {
    window.removeEventListener("DOMContentLoaded", this, false);
    window.addEventListener("SSTabRestoring", this, false);

    this.l10n = document.getElementById('bartap-strings');

    let tabbrowser = document.getElementById("content");
    this.initTabBrowser(tabbrowser);
  },

  /* This is deliberately its own method so that extensions that have
     other tabbrowsers can call it. */
  initTabBrowser: function(tabbrowser) {
    tabbrowser.tabContainer.addEventListener('TabSelect', this, false);

    /* Monkey patch our way into the tab browser.  This is by far the most
       efficient but also ugliest way :\ */
    eval('tabbrowser.mTabProgressListener = '+tabbrowser.mTabProgressListener.toSource().replace(
        /\{(this.mTab.setAttribute\("busy", "true"\);[^\}]+)\}/,
        'if (!BarTap.onTabStateChange(this.mTab)) { $1 }'
    ));

    eval('tabbrowser.addTab = '+tabbrowser.addTab.toSource().replace(
        'b.loadURIWithFlags(aURI, flags, aReferrerURI, aCharset, aPostData)',
        'BarTap.writeBarTap(t, b, aURI, flags, aReferrerURI, aCharset, aPostData); $&'
    ));

    /* Tab Mix Plus compatibility: It likes reusing blank tabs.  In doing
       so it confuses tabs on the bar tab with blank ones.  Fix that. */
    if (tabbrowser.isBlankBrowser) {
      tabbrowser.TMPisBlankBrowser = tabbrowser.isBlankBrowser;
      tabbrowser.isBlankBrowser = function (aBrowser) {
        if (aBrowser.getAttribute("ontap") == "true") {
          return false;
        }
        return this.TMPisBlankBrowser(aBrowser);
      };
    }

    /* When the user wants one or all tabs to reload, do the right thing
       in case it's tapped. */
    tabbrowser.reloadTab = function(aTab) {
      if (aTab.getAttribute("ontap") == "true") {
        BarTap.loadTabContents(aTab);
        if (!aTab.selected) {
          tabbrowser.BarTapTimer.startTimer(aTab);
        }
        return;
      }
      aTab.linkedBrowser.reload();
    };
    tabbrowser.reloadAllTabs = function() {
      for (var i = 0; i < this.mTabs.length; i++) {
        try {
          this.reloadTab(this.mTabs[i]);
        } catch (e) {
          // ignore failure to reload so others will be reloaded
        }
      }
    };

    /* Initialize timer */
    tabbrowser.BarTapTimer = new BarTapTimer(tabbrowser);

    /* Insert context menu items for putting tabs back on your bar tab */

    let popup = document.getAnonymousElementByAttribute(tabbrowser, "anonid", "tabContextMenu");
    let before = document.getAnonymousElementByAttribute(tabbrowser, "id", "context_openTabInWindow");

    let putontap = document.createElement('menuitem');
    putontap.setAttribute('id', 'context_putOnTap');
    putontap.setAttribute('label', this.l10n.getString('putOnTap'));
    putontap.setAttribute('tbattr', 'tabbrowser-multiple');
    putontap.setAttribute('oncommand', "var tabbrowser = this.parentNode.parentNode.parentNode.parentNode; BarTap.putOnTap(tabbrowser.mContextTab, tabbrowser);");
    popup.insertBefore(putontap, before);

    let putallontap = document.createElement('menuitem');
    putallontap.setAttribute('id', 'context_putAllOnTapBut');
    putallontap.setAttribute('label', this.l10n.getString('putAllOnTapBut'));
    putallontap.setAttribute('tbattr', 'tabbrowser-multiple');
    putallontap.setAttribute('oncommand', "var tabbrowser = this.parentNode.parentNode.parentNode.parentNode; BarTap.putAllOnTapBut(tabbrowser.mContextTab, tabbrowser);");
    popup.insertBefore(putallontap, before);

    let neverputontap = document.createElement('menuitem');
    neverputontap.setAttribute('id', 'context_neverPutOnTap');
    neverputontap.setAttribute('tbattr', 'tabbrowser-multiple');
    neverputontap.setAttribute('type', 'checkbox');
    neverputontap.setAttribute('autocheck', 'false');
    neverputontap.setAttribute('oncommand', "var tabbrowser = this.parentNode.parentNode.parentNode.parentNode; BarTap.toggleHostWhitelist(tabbrowser.mContextTab, tabbrowser);");
    popup.insertBefore(neverputontap, before);

    popup.insertBefore(document.createElement('menuseparator'), before);
    popup.addEventListener('popupshowing', this, false);
  },

  onPopupShowing: function(event) {
    if (event.target != event.currentTarget) {
      return;
    }

    // TODO The following two lines don't work for multiple tabbrowsers.
    let neverputontap = document.getElementById("context_neverPutOnTap");
    let putontap = document.getElementById("context_putOnTap");

    // TODO the tab could also be unloaded (so uri is about:blank),
    // but one still might want to put the host on the whitelist.
    let uri = document.popupNode.linkedBrowser.currentURI;
    try {
      let label = this.l10n.getFormattedString('neverPutOnTap', [uri.host]);
      neverputontap.setAttribute("label", label);
      if (this.getHostWhitelist().indexOf(uri.host) == -1) {
        neverputontap.removeAttribute("checked");
        putontap.removeAttribute("disabled");
      } else {
        neverputontap.setAttribute("checked", "true");
        putontap.setAttribute("disabled", "true");
      }
      neverputontap.removeAttribute("hidden");
    } catch (ex) {
      /* Most likely uri.host doesn't exist which probably means whitelisting
         doesn't make sense on this tab.  Don't show the menu item */
      neverputontap.setAttribute("hidden", "true");
      putontap.removeAttribute("disabled");
    }
  },

  toggleHostWhitelist: function(tab, tabbrowser) {
    // TODO the tab could also be tapped (so uri is about:blank)
    var uri = tab.linkedBrowser.currentURI;
    try {
      var host = uri.host;
    } catch(ex) {
      /* Most likely uri.host doesn't exist.  Ignore then. */
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

  /* Listens to the 'SSTabRestoring' event from the nsISessionStore service
     and puts a marker on restored tabs. */
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

  /* Called when a tab is opened with a new URI (e.g. by opening a link in
     a new tab.) Stores the parameters on the tab so that 'onTabStateChange'
     can carry out the action later. */
  writeBarTap: function(aTab, aBrowser, aURI, aFlags, aReferrerURI, aCharset, aPostData) {
    if (!aURI) {
      return;
    }
    if (this.mPrefs.getBoolPref("extensions.bartap.tapBackgroundTabs")) {
      let bartap = "";
      if (aURI) {
        bartap = JSON.stringify({
          uri:      (aURI instanceof Ci.nsIURI) ? aURI.spec : aURI,
          flags:    aFlags,
          referrer: (aReferrerURI instanceof Ci.nsIURI) ? aReferrerURI.spec : aReferrerURI,
          charset:  aCharset,
          postdata: aPostData
        });
      }
      aTab.setAttribute("ontap", "true");
      aBrowser.setAttribute("ontap", "true");
      aBrowser.setAttribute("bartap", bartap);
    } else if (this.mPrefs.getBoolPref("extensions.bartap.tapAfterTimeout")) {
      this.getTabBrowserForTab(aTab).BarTapTimer.startTimer(aTab);
    }
  },

  /* Called when the browser wants to load stuff into a tab.  If the tab has
     been placed on tap, stop the loading and defer to an event listener.
     Returns true of the tab has been tapped. */
  onTabStateChange: function(tab) {
    if (tab.getAttribute("ontap") != "true") {
      return false;
    }

    /* We need these here because they leak into the event listener below. */
    var browser = tab.linkedBrowser;
    var history = browser.webNavigation.sessionHistory;
    var bartap = browser.getAttribute("bartap");
    var gotoindex;
    var gotouri;

    if (bartap) {
      /* The tab was likely opened by clicking on a link */
      browser.removeAttribute("bartap");
      bartap = JSON.parse(bartap);
      gotouri = makeURI(bartap.uri);
    } else if (history.count) {
      /* Likely a restored tab, try loading from history. */
      gotoindex = history.requestedIndex;
      if (gotoindex == -1) {
        gotoindex = history.index;
      }
      gotouri = history.getEntryAtIndex(gotoindex, false).URI;
    } else if (browser.userTypedValue) {
      /* This might not make much sense here... */
      gotouri = makeURI(browser.userTypedValue);
    }

    /* Check whether we should put this URI on the bar tab or not. */
    if (gotouri) {
      try {
        if (this.getHostWhitelist().indexOf(gotouri.host) != -1) {
          tab.removeAttribute("ontap");
          browser.removeAttribute("ontap");
          return false;          
        }
      } catch(ex) {
        /* Most likely gotouri.host failed.  No matter, just carry on. */
      }
    }

    browser.stop();

    if (gotouri) {
      /* See if we have title, favicon in stock for it. This should definitely
         work for restored tabs as they're in the history database. */
      let info = this.getInfoFromHistory(gotouri);
      if (info) {
        /* Firefox cripples nsINavHistoryService entries for fragment links.
           See https://bugzilla.mozilla.org/show_bug.cgi?id=420605
           Try to work around that by stripping the fragment from the URI. */
        let anchor = gotouri.path.indexOf('#');
        if (!info.icon && (anchor != -1)) {
          let uri = gotouri.clone();
          uri.path = uri.path.substr(0, anchor);
          let anchorinfo = this.getInfoFromHistory(uri);
          if (anchorinfo) {
            info = anchorinfo;
          }
        }
        tab.setAttribute("image", info.icon);
        tab.label = info.title;
      } else {
        try {
          /* Set a meaningful part of the URI as tab label */
          let hostPort = gotouri.hostPort;
          let path = gotouri.path;
          if (hostPort.substr(0, 4) == "www.") {
            hostPort = hostPort.substr(4);
          }
          if (path == "/") {
            path = "";
          }
          tab.label = hostPort + path;
        } catch (ex) {
          /* Most likely gotouri.hostPort and gotouri.path failed.
             Let's handle this gracefully. */
          tab.label = gotouri.spec;
        }
      }
    }

    browser.addEventListener("BarTapLoad", function() {
        browser.removeEventListener("BarTapLoad", arguments.callee, false);

        if (bartap) {
          /* The referrer might be undefined. */
          let referrer = bartap.referrer;
          if (referrer) {
            referrer = makeURI(referrer);
          }
          /* Gotta love the inconsistency of this API */
          browser.loadURIWithFlags(bartap.uri, bartap.flags, referrer,
                                   bartap.charset, bartap.postdata);
        } else if (history.count) {
          browser.webNavigation.gotoIndex(gotoindex);
        } else if (browser.userTypedValue) {
          /* This might not make much sense here... */
          browser.loadURI(browser.userTypedValue);
        }
      }, false);

    return true;
  },

  onTabSelect: function(event) {
    var tab = event.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
      return;
    }
    this.loadTabContents(tab);
  },

  loadTabContents: function(tab) {
    /* Remove marker so that we can proceed loading the browser contents or,
       in case of about:blank where there's no event handler, continue to
       function normally. */
    tab.removeAttribute("ontap");
    tab.linkedBrowser.removeAttribute("ontap");

    let event = document.createEvent("Event");
    event.initEvent("BarTapLoad", true, true);
    tab.linkedBrowser.dispatchEvent(event);
  },

  putOnTap: function(aTab, aTabBrowser) {
    /* Ignore tabs that are already unloaded or are on the host whitelist. */
    if (aTab.getAttribute("ontap") == "true") {
      return;
    }
    try {
      let uri = aTab.linkedBrowser.currentURI;
      if (this.getHostWhitelist().indexOf(uri.host) != -1) {
        return;
      }
    } catch(ex) {
      /* Most likely uri.host failed.  No matter, just carry on. */
    }

    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    /* Make sure that we're not on this tab.  If we are, find the closest
       tab that isn't on the bar tab. */
    if (aTab.selected) {
      let activeTab = this.findClosestUntappedTab(aTab, aTabBrowser);
      if (activeTab) {
        aTabBrowser.selectedTab = activeTab;
      }
    }

    var sessionstore = Components.classes["@mozilla.org/browser/sessionstore;1"]
                       .getService(Components.interfaces.nsISessionStore);
    var state = sessionstore.getTabState(aTab);
    var newtab = aTabBrowser.addTab();

    /* The user might not have the 'extensions.bartap.tapRestoredTabs'
       preference enabled but still wants to put this tab on the bar tab.
       That's why we need to make sure this attribute exists before
       restoring the tab state. */
    newtab.setAttribute("ontap", "true");
    newtab.linkedBrowser.setAttribute("ontap", "true");
    sessionstore.setTabState(newtab, state);

    /* Move the new tab next to the one we're removing, but not in front
       of it as that confuses Tree Style Tab. */
    aTabBrowser.moveTabTo(newtab, aTab._tPos + 1);

    /* Restore tree when using Tree Style Tab */
    if (aTabBrowser.treeStyleTab) {
      let children = aTabBrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
          aTabBrowser.treeStyleTab.attachTabTo(
              aChild, newtab, {dontAnimate: true});
        });
    }

    /* Close the original tab.  We're taking the long way round to ensure the
       nsISessionStore service won't save this in the recently closed tabs. */
    aTabBrowser._endRemoveTab(aTabBrowser._beginRemoveTab(aTab, true, null, false));
  },

  putAllOnTapBut: function(aTab, aTabBrowser) {
    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    /* Make sure we're sitting on the tab that isn't going to be unloaded */
    if (aTabBrowser.selectedTab != aTab) {
      aTabBrowser.selectedTab = aTab;
    }

    /* putOnTap() mutates the tabs so the only sane thing to do is to copy
       the list of tabs now and then work off that list. */
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

  /* In relation to a given tab, find the closest tab that isn't on the
     bar tab.  Note: if there's no such tab available, this will return
     tabs on the bar tab as a last resort. */
  findClosestUntappedTab: function(aTab, aTabBrowser) {
    /* Shortcut: if this is the only tab available, we're not going to
       find another active one, are we... */
    if (aTabBrowser.mTabs.length == 1) {
      return null;
    }

    /* The most obvious choice would be the owner tab, if it's active */
    if (aTab.owner && aTab.owner.getAttribute("ontap") != "true") {
      return aTab.owner;
    }

    /* Otherwise walk the tab list and see if we can find an active one */
    let i;
    for (i = aTab._tPos + 1; i < aTabBrowser.mTabs.length; i++) {
      if (aTabBrowser.mTabs[i].getAttribute("ontap") != "true") {
        return aTabBrowser.mTabs[i];
      }
    }
    for (i = aTab._tPos - 1; i >= 0; i--) {
      if (aTabBrowser.mTabs[i].getAttribute("ontap") != "true") {
        return aTabBrowser.mTabs[i];
      }
    }

    /* Fallback: there isn't an active tab available, so we're going to have
       to nominate a non-active one. */
    if (aTab.owner) {
      return aTab.owner;
    }
    if (aTab.nextSibling) {
      return aTab.nextSibling;
    }
    return aTab.previousSibling;
  },

  /* Get information about a URI from the history service,
     e.g. title, favicon, ... */
  getInfoFromHistory: function(aURI) {
    var history = Cc["@mozilla.org/browser/nav-history-service;1"]
                    .getService(Ci.nsINavHistoryService);

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
    while (tab.localName != 'tabbrowser') {
      tab = tab.parentNode;
    }
    return tab;
  },

  /* It might seem more elegant to use a getter & setter here so you could
     just use this.hostWhiteList or similar.  However, that would suggest
     this.hostWhiteList would always return the same array and that
     mutations to it would be persisted.  Both are not the case. */

  getHostWhitelist: function() {
    return this.mPrefs.getCharPref("extensions.bartap.hostWhitelist").split(";");
  },

  setHostWhitelist: function(whitelist) {
    this.mPrefs.setCharPref("extensions.bartap.hostWhitelist",
                            whitelist.join(";"));
  }

};

window.addEventListener("DOMContentLoaded", BarTap, false);


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
    /* Allow 'this' to leak into the inline function */
    var self = this;
    aTab._barTapTimer = window.setTimeout(function() {
        /* The timer will be removed automatically since BarTap.putOnTab
           will close and replace the original tab. */
        BarTap.putOnTap(aTab, self.tabbrowser);
      }, secs*1000);
  },

  clearTimer: function(aTab) {
    window.clearTimeout(aTab._barTapTimer);
    aTab._barTapTimer = null;
  }
}
