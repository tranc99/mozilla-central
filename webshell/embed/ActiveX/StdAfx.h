// stdafx.h : include file for standard system include files,
//      or project specific include files that are used frequently,
//      but are changed infrequently

#if !defined(AFX_STDAFX_H__1339B542_3453_11D2_93B9_000000000000__INCLUDED_)
#define AFX_STDAFX_H__1339B542_3453_11D2_93B9_000000000000__INCLUDED_

#if _MSC_VER >= 1000
#pragma once
#endif // _MSC_VER >= 1000

#define STRICT


#define _WIN32_WINNT 0x0400
#define _ATL_APARTMENT_THREADED


#include <atlbase.h>
//You may derive a class from CComModule and use it if you want to override
//something, but do not change the name of _Module
extern CComModule _Module;
#include <atlcom.h>
#include <atlctl.h>

#ifdef USE_NGPREF
#include "nsIPref.h"
#endif

#include "prtypes.h"
#include "xp_core.h"
#include "jscompat.h"

#include "prthread.h"
#include "prprf.h"
#include "plevent.h"
#include "nsRepository.h"
#include "nsWidgetsCID.h"
#include "nsGfxCIID.h"
#include "nsViewsCID.h"
#include "nsString.h"

#include "nsGlobalVariables.h"
#include "nsIWebShell.h"
#include "nsIPresContext.h"
#include "nsIDocument.h"
#include "nsIDocumentObserver.h"
#include "nsIStreamListener.h"
#include "nsUnitConversion.h"
#include "nsVoidArray.h"
#include "nsCRT.h"

#include "BrowserDiagnostics.h"
#include "MozillaControl.h"
#include "WebShellContainer.h"
#include "MozillaBrowser.h"

//{{AFX_INSERT_LOCATION}}
// Microsoft Developer Studio will insert additional declarations immediately before the previous line.

#endif // !defined(AFX_STDAFX_H__1339B542_3453_11D2_93B9_000000000000__INCLUDED)
