/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public License
 * Version 1.0 (the "NPL"); you may not use this file except in
 * compliance with the NPL.  You may obtain a copy of the NPL at
 * http://www.mozilla.org/NPL/
 *
 * Software distributed under the NPL is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the NPL
 * for the specific language governing rights and limitations under the
 * NPL.
 *
 * The Initial Developer of this code under the NPL is Netscape
 * Communications Corporation.  Portions created by Netscape are
 * Copyright (C) 1999 Netscape Communications Corporation.  All Rights
 * Reserved.
 */

/* Platform specific code to invoke XPCOM methods on native objects */

#include "xpcprivate.h"

static const char* XPC_QUERY_INTERFACE_STR = "QueryInterface";

NS_IMPL_ISUPPORTS1(nsXPCWrappedJSClass, nsIXPCWrappedJSClass)

// the value of this variable is never used - we use its address as a sentinel
static uint32 zero_methods_descriptor;

// static
nsXPCWrappedJSClass*
nsXPCWrappedJSClass::GetNewOrUsedClass(XPCContext* xpcc,
                                       REFNSIID aIID)
{
    IID2WrappedJSClassMap* map;
    nsXPCWrappedJSClass* clazz = nsnull;

    NS_PRECONDITION(xpcc, "bad param");

    map = xpcc->GetWrappedJSClassMap();
    NS_ASSERTION(map,"bad map");

    clazz = map->Find(aIID);
    if(clazz)
    {
        NS_ADDREF(clazz);
    }
    else
    {
        nsIInterfaceInfoManager* iimgr;
        if(nsnull != (iimgr = nsXPConnect::GetInterfaceInfoManager()))
        {
            nsIInterfaceInfo* info;
            if(NS_SUCCEEDED(iimgr->GetInfoForIID(&aIID, &info)))
            {
                if(nsXPConnect::IsISupportsDescendent(info))
                {
                    clazz = new nsXPCWrappedJSClass(xpcc, aIID, info);
                    if(!clazz->mDescriptors)
                        NS_RELEASE(clazz);  // sets clazz to nsnull
                }
                NS_RELEASE(info);
            }
            NS_RELEASE(iimgr);
        }
    }
    return clazz;
}

nsXPCWrappedJSClass::nsXPCWrappedJSClass(XPCContext* xpcc, REFNSIID aIID,
                                         nsIInterfaceInfo* aInfo)
    : mXPCContext(xpcc),
      mInfo(aInfo),
      mName(nsnull),
      mIID(aIID),
      mDescriptors(nsnull)
{
    NS_ADDREF(mInfo);

    NS_INIT_REFCNT();
    NS_ADDREF_THIS();

    mXPCContext->GetWrappedJSClassMap()->Add(this);

    uint16 methodCount;
    if(NS_SUCCEEDED(mInfo->GetMethodCount(&methodCount)))
    {
        if(methodCount)
        {
            int wordCount = (methodCount/32)+1;
            if(nsnull != (mDescriptors = new uint32[wordCount]))
            {
                int i;
                // init flags to 0;
                for(i = wordCount-1; i >= 0; i--)
                    mDescriptors[i] = 0;

                for(i = 0; i < methodCount; i++)
                {
                    const nsXPTMethodInfo* info;
                    if(NS_SUCCEEDED(mInfo->GetMethodInfo(i, &info)))
                        SetReflectable(i, XPCConvert::IsMethodReflectable(*info));
                    else
                    {
                        delete [] mDescriptors;
                        mDescriptors = nsnull;
                        break;
                    }
                }
            }
        }
        else
        {
            mDescriptors = &zero_methods_descriptor;
        }
    }
}

nsXPCWrappedJSClass::~nsXPCWrappedJSClass()
{
    if(mDescriptors && mDescriptors != &zero_methods_descriptor)
        delete [] mDescriptors;
    if(mXPCContext)
        mXPCContext->GetWrappedJSClassMap()->Remove(this);
    if(mName)
        nsAllocator::Free(mName);
    NS_RELEASE(mInfo);
}

JSObject*
nsXPCWrappedJSClass::CallQueryInterfaceOnJSObject(JSObject* jsobj, REFNSIID aIID)
{
    JSContext* cx = GetJSContext();
    JSObject* id;
    jsval retval;
    JSObject* retObj;
    JSBool success = JS_FALSE;

    if(!cx)
        return nsnull;

    id = xpc_NewIDObject(cx, aIID);

    if(id)
    {
        jsval e;
        JSBool hadExpection = JS_GetPendingException(cx, &e);
        JSErrorReporter older = JS_SetErrorReporter(cx, nsnull);
        jsval args[1] = {OBJECT_TO_JSVAL(id)};
        success = JS_CallFunctionName(cx, jsobj, XPC_QUERY_INTERFACE_STR,
                                      1, args, &retval);
        if(success)
            success = JS_ValueToObject(cx, retval, &retObj);
        JS_SetErrorReporter(cx, older);
        if(hadExpection)
            JS_SetPendingException(cx, e);
        else
            JS_ClearPendingException(cx);
    }

    return success ? retObj : nsnull;
}

/***************************************************************************/
// This 'WrappedJSIdentity' class and singleton allow us to figure out if
// any given nsISupports* is implemented by a WrappedJS object. This is done
// using a QueryInterface call on the interface pointer with our ID. If
// that call returns NS_OK and the pointer is to our singleton, then the
// interface must be implemented by a WrappedJS object. NOTE: the
// 'WrappedJSIdentity' object is not a real XPCOM object and should not be
// used for anything else (hence it is declared in this implementation file).

// {5C5C3BB0-A9BA-11d2-BA64-00805F8A5DD7}
#define NS_IXPCONNECT_WRAPPED_JS_IDENTITY_CLASS_IID \
{ 0x5c5c3bb0, 0xa9ba, 0x11d2,                       \
  { 0xba, 0x64, 0x0, 0x80, 0x5f, 0x8a, 0x5d, 0xd7 } }

class WrappedJSIdentity
{
    // no instance methods...
public:
    NS_DEFINE_STATIC_IID_ACCESSOR(NS_IXPCONNECT_WRAPPED_JS_IDENTITY_CLASS_IID)

    static void* GetSingleton()
    {
        static WrappedJSIdentity* singleton = nsnull;
        if(!singleton)
            singleton = new WrappedJSIdentity();
        return (void*) singleton;
    }
};

/***************************************************************************/

// static
JSBool
nsXPCWrappedJSClass::IsWrappedJS(nsISupports* aPtr)
{
    void* result;
    NS_PRECONDITION(aPtr, "null pointer");
    return aPtr &&
           NS_OK == aPtr->QueryInterface(WrappedJSIdentity::GetIID(), &result) &&
           result == WrappedJSIdentity::GetSingleton();
}

NS_IMETHODIMP
nsXPCWrappedJSClass::DelegatedQueryInterface(nsXPCWrappedJS* self,
                                             REFNSIID aIID,
                                             void** aInstancePtr)
{
    nsXPCWrappedJS* sibling;

    // This includes checking for nsISupports and the iid of self.
    // And it also checks for other wrappers that have been constructed
    // for this object.
    if(nsnull != (sibling = self->Find(aIID)))
    {
        NS_ADDREF(sibling);
        *aInstancePtr = (void*) sibling;
        return NS_OK;
    }

    if(aIID.Equals(WrappedJSIdentity::GetIID()))
    {
        // asking to find out if this is a wrapper object
        *aInstancePtr = WrappedJSIdentity::GetSingleton();
        return NS_OK;
    }

    // else...

    // check if asking for an interface that we inherit from
    nsIInterfaceInfo* current = GetInterfaceInfo();
    NS_ADDREF(current);
    nsIInterfaceInfo* parent;

    while(NS_SUCCEEDED(current->GetParent(&parent)) && parent)
    {
        NS_RELEASE(current);
        current = parent;

        nsIID* iid;
        if(NS_SUCCEEDED(current->GetIID(&iid)) && iid)
        {
            PRBool found = aIID.Equals(*iid);
            nsAllocator::Free(iid);
            if(found)
            {
                NS_RELEASE(current);
                *aInstancePtr = (void*) self;
                NS_ADDREF(self);
                return NS_OK;
            }
        }
    }
    NS_RELEASE(current);

    // else...
    // check if the JSObject claims to implement this interface
    JSObject* jsobj = CallQueryInterfaceOnJSObject(self->GetJSObject(), aIID);
    if(jsobj)
    {
        nsXPCWrappedJS* wrapper =
            nsXPCWrappedJS::GetNewOrUsedWrapper(GetXPCContext(),
                                                jsobj, aIID);
        if(wrapper)
        {
            *aInstancePtr = (void*) wrapper;
            return NS_OK;
        }
    }

    // else...
    // no can do
    *aInstancePtr = nsnull;
    return NS_NOINTERFACE;
}

JSObject*
nsXPCWrappedJSClass::GetRootJSObject(JSObject* aJSObj)
{
    JSObject* result = CallQueryInterfaceOnJSObject(aJSObj, nsCOMTypeInfo<nsISupports>::GetIID());
    return result ? result : aJSObj;
}

JS_STATIC_DLL_CALLBACK(void)
xpcWrappedJSErrorReporter(JSContext *cx, const char *message,
                          JSErrorReport *report)
{
    nsIXPCException* e;
    XPCContext* xpcc;
    if(nsnull != (e = XPCConvert::JSErrorToXPCException(cx, message, report))&&
       nsnull != (xpcc = nsXPConnect::GetContext(cx)))
        xpcc->SetException(e);
}

NS_IMETHODIMP
nsXPCWrappedJSClass::CallMethod(nsXPCWrappedJS* wrapper, uint16 methodIndex,
                                const nsXPTMethodInfo* info,
                                nsXPTCMiniVariant* params)
{
    jsval* stackbase;
    jsval* sp = nsnull;
    uint8 i;
    uint8 argc=0;
    jsval result;
    uint8 paramCount=0;
    nsresult retval = NS_ERROR_FAILURE;
    nsresult pending_result = NS_OK;
    JSErrorReporter older;
    JSBool success;
    JSContext* cx = GetJSContext();
    JSBool InConversionsDone = JS_FALSE;
    nsID* conditional_iid = nsnull;
    JSBool iidIsOwned = JS_FALSE;
    JSObject* obj = wrapper->GetJSObject();
    const char* name = info->GetName();
    nsIXPCException* xpc_exception;
    jsval js_exception;
    void* mark;
    nsXPConnect* xpc = nsXPConnect::GetXPConnect();

#ifdef DEBUG_stats_jband
    static int count = 0;
    static const int interval = 10;
    if(0 == (++count % interval))
        printf("<<<<<<<< %d calls on nsXPCWrappedJSs made\n", count);
#endif

    // XXX ASSUMES that retval is last arg.
    paramCount = info->GetParamCount();
    argc = paramCount -
            (paramCount && info->GetParam(paramCount-1).IsRetval() ? 1 : 0);

    if(cx)
        older = JS_SetErrorReporter(cx, xpcWrappedJSErrorReporter);

    if(!xpc || !mXPCContext || !cx || !IsReflectable(methodIndex))
        goto pre_call_clean_up;

    mXPCContext->SetPendingResult(pending_result);
    mXPCContext->SetException(nsnull);
    xpc->SetPendingException(nsnull);

    // We use js_AllocStack, js_Invoke, and js_FreeStack so that the gcthings
    // we use as args will be rooted by the engine as we do conversions and
    // prepare to do the function call. This adds a fair amount of complexity,
    // but is a good optimization compared to calling JS_AddRoot for each item.

    // setup stack
    if(nsnull == (stackbase = sp = js_AllocStack(cx, argc + 2, &mark)))
    {
        retval = NS_ERROR_OUT_OF_MEMORY;
        goto pre_call_clean_up;
    }

    // if this is a function call, then push function and 'this'
    if(!info->IsGetter() && !info->IsSetter())
    {
        jsval fval;

        if(!JS_GetProperty(cx, obj, name, &fval))
            goto pre_call_clean_up;
        *sp++ = fval;
        *sp++ = OBJECT_TO_JSVAL(obj);
    }
    else
    {
        sp += 2;
    }

    // build the args
    for(i = 0; i < argc; i++)
    {
        const nsXPTParamInfo& param = info->GetParam(i);
        const nsXPTType& type = param.GetType();
        jsval val;

        if(param.IsIn())
        {
            nsXPTCMiniVariant* pv;

            if(param.IsOut())
                pv = (nsXPTCMiniVariant*) params[i].val.p;
            else
                pv = &params[i];

            if(type.TagPart() == nsXPTType::T_INTERFACE)
            {
                if(NS_FAILED(GetInterfaceInfo()->
                        GetIIDForParam(methodIndex, &param, &conditional_iid)))
                {
                    goto pre_call_clean_up;
                }
                iidIsOwned = JS_TRUE;
            }
            else if(type.TagPart() == nsXPTType::T_INTERFACE_IS)
            {
                uint8 arg_num = param.GetInterfaceIsArgNumber();
                const nsXPTParamInfo& param = info->GetParam(arg_num);
                const nsXPTType& type = param.GetType();
                if(type.IsPointer() && type.TagPart() == nsXPTType::T_IID)
                {
                    if(param.IsOut())
                       conditional_iid = *((nsID**)params[arg_num].val.p);
                    else
                       conditional_iid = (nsID*) params[arg_num].val.p;
                }
                if(!conditional_iid)
                    goto pre_call_clean_up;
            }

            if(!XPCConvert::NativeData2JS(cx, &val, &pv->val, type,
                                          conditional_iid, nsnull))
            {
                goto pre_call_clean_up;
            }
            if(conditional_iid)
            {
                if(iidIsOwned)
                {
                    nsAllocator::Free((void*)conditional_iid);
                    iidIsOwned = JS_FALSE;
                }
                conditional_iid = nsnull;
            }
        }

        if(param.IsOut())
        {
            // create an 'out' object
            JSObject* obj = NewOutObject();
            if(param.IsIn())
            {
                if(!JS_SetProperty(cx, obj, XPC_VAL_STR, &val))
                    goto pre_call_clean_up;
            }
            *sp++ = OBJECT_TO_JSVAL(obj);
        }
        else
            *sp++ = val;
    }
    InConversionsDone = JS_TRUE;

pre_call_clean_up:
    // clean up any 'out' params handed in
    for(i = 0; i < paramCount; i++)
    {
        const nsXPTParamInfo& param = info->GetParam(i);
        if(!param.IsOut())
            continue;

        const nsXPTType& type = param.GetType();
        if(!type.IsPointer())
            continue;
        if(!params[i].val.p)
            continue;

        if(type.IsInterfacePointer())
        {
            if(param.IsIn())
            {
                nsISupports** pp;
                if((nsnull != (pp = (nsISupports**) params[i].val.p)) &&
                    nsnull != *pp)
                {
                    (*pp)->Release();
                    *pp = nsnull;
                }
            }
        }
        else
        {
            void** pp;
            if((nsnull != (pp = (void**) params[i].val.p)) && nsnull != *pp)
            {
                if(param.IsIn())
                    nsAllocator::Free(*pp);
                *pp = nsnull;
            }
        }
    }

    if(conditional_iid)
    {
        if(iidIsOwned)
        {
            nsAllocator::Free((void*)conditional_iid);
            iidIsOwned = JS_FALSE;
        }
        conditional_iid = nsnull;
    }

    if(!InConversionsDone)
        goto done;

    // do the deed - note exceptions

    JS_ClearPendingException(cx);

    if(info->IsGetter())
        success = JS_GetProperty(cx, obj, name, &result);
    else if(info->IsSetter())
        success = JS_SetProperty(cx, obj, name, sp-1);
    else
    {
        // Lift current frame (or make new one) to include the args
        // and do the call.
        JSStackFrame *fp, *oldfp, frame;
        jsval *oldsp;

        fp = oldfp = cx->fp;
        if(!fp)
        {
            memset(&frame, 0, sizeof frame);
            cx->fp = fp = &frame;
        }
        oldsp = fp->sp;
        fp->sp = sp;
        success = js_Invoke(cx, argc, JS_FALSE);
        result = fp->sp[-1];
        fp->sp = oldsp;
        if(oldfp != fp)
            cx->fp = oldfp;
    }

    /* this one would be set by our error reporter */
    xpc_exception = mXPCContext->GetException();
    if(xpc_exception)
        mXPCContext->SetException(nsnull);

    // get this right away in case we do something below to cause JS code
    // to run on this JSContext
    pending_result = mXPCContext->GetPendingResult();

    /* JS might throw an expection whether the reporter was called or not */
    if(JS_GetPendingException(cx, &js_exception))
    {
        if(!xpc_exception)
            xpc_exception = XPCConvert::JSValToXPCException(cx, js_exception,
                                                    GetInterfaceName(), name);

        /* cleanup and set failed even if we can't build an exception */
        if(!xpc_exception)
        {
            xpc->SetPendingException(nsnull); // XXX necessary?
            success = JS_FALSE;
        }
        JS_ClearPendingException(cx);
    }

    if(xpc_exception)
    {
        nsresult e_result;
        if(NS_SUCCEEDED(xpc_exception->GetResult(&e_result)))
        {
            if(NS_FAILED(e_result))
            {
                xpc->SetPendingException(xpc_exception);
                retval = e_result;
            }
        }
        NS_RELEASE(xpc_exception);
        success = JS_FALSE;
    }
    else
    {
        // see if JS code signaled failure result without throwing exception
        if(NS_FAILED(pending_result))
        {
            retval = pending_result;
            success = JS_FALSE;
        }
    }

    if(!success)
        goto done;

    xpc->SetPendingException(nsnull); // XXX necessary?

    // convert out args and result
    // NOTE: this is the total number of native params, not just the args
    for(i = 0; i < paramCount; i++)
    {
        const nsXPTParamInfo& param = info->GetParam(i);

        if(param.IsOut())
        {
            jsval val;
            JSBool useAllocator = JS_FALSE;
            const nsXPTType& type = param.GetType();
            nsXPTCMiniVariant* pv;

            pv = (nsXPTCMiniVariant*) params[i].val.p;

            if(param.IsRetval())
                val = result;
            else if(!JS_GetProperty(cx, JSVAL_TO_OBJECT(stackbase[i+2]), XPC_VAL_STR, &val))
                break;

            // setup allocator and/or iid

            if(type.TagPart() == nsXPTType::T_INTERFACE)
            {
                if(NS_FAILED(GetInterfaceInfo()->
                        GetIIDForParam(methodIndex, &param, &conditional_iid)))
                {
                    break;
                }
                iidIsOwned = JS_TRUE;
            }
            else if(type.TagPart() == nsXPTType::T_INTERFACE_IS)
            {
                uint8 arg_num = param.GetInterfaceIsArgNumber();
                const nsXPTParamInfo& param = info->GetParam(arg_num);
                const nsXPTType& type = param.GetType();
                if(!type.IsPointer() || type.TagPart() != nsXPTType::T_IID)
                    break;
                if(param.IsOut())
                    conditional_iid = *((nsID**)params[arg_num].val.p);
                else
                    conditional_iid = (nsID*) params[arg_num].val.p;
                if(!conditional_iid)
                    break;
            }
            else if(type.IsPointer() && !param.IsShared())
                useAllocator = JS_TRUE;

            if(!XPCConvert::JSData2Native(cx, &pv->val, val, type,
                                        useAllocator, conditional_iid, nsnull))
                break;

            if(conditional_iid)
            {
                if(iidIsOwned)
                {
                    nsAllocator::Free((void*)conditional_iid);
                    iidIsOwned = JS_FALSE;
                }
                conditional_iid = nsnull;
            }
        }
    }

    // if we didn't manage all the result conversions then we have
    // to cleanup any junk that *did* get converted.
    if(i != paramCount)
    {
        // XXX major spaghetti!
        InConversionsDone = JS_FALSE;
        goto pre_call_clean_up;
    }

    // set to whatever the JS code might have set as the result
    retval = pending_result;

done:
    if(sp)
        js_FreeStack(cx, mark);

    if(conditional_iid && iidIsOwned)
        nsAllocator::Free((void*)conditional_iid);

    if(cx)
        JS_SetErrorReporter(cx, older);

    return retval;
}

static JSClass WrappedJSOutArg_class = {
    "XPCOutArg", 0,
    JS_PropertyStub,  JS_PropertyStub,  JS_PropertyStub,  JS_PropertyStub,
    JS_EnumerateStub, JS_ResolveStub,   JS_ConvertStub,   JS_FinalizeStub
};

// static
JSBool
nsXPCWrappedJSClass::InitForContext(XPCContext* xpcc)
{
    if (!JS_InitClass(xpcc->GetJSContext(), xpcc->GetGlobalObject(),
        0, &WrappedJSOutArg_class, 0, 0,
        0, 0,
        0, 0))
        return JS_FALSE;
    return JS_TRUE;
}

const char*
nsXPCWrappedJSClass::GetInterfaceName()
{
    if(!mName)
        mInfo->GetName(&mName);
    return mName;
}

JSObject*
nsXPCWrappedJSClass::NewOutObject()
{
    return JS_NewObject(GetJSContext(), &WrappedJSOutArg_class, nsnull, nsnull);
}

void
nsXPCWrappedJSClass::XPCContextBeingDestroyed()
{
    mXPCContext = nsnull;
}

NS_IMETHODIMP
nsXPCWrappedJSClass::DebugDump(int depth)
{
#ifdef DEBUG
    depth-- ;
    XPC_LOG_ALWAYS(("nsXPCWrappedJSClass @ %x with mRefCnt = %d", this, mRefCnt));
    XPC_LOG_INDENT();
        char* name;
        mInfo->GetName(&name);
        XPC_LOG_ALWAYS(("interface name is %s", name));
        if(name)
            nsAllocator::Free(name);
        char * iid = mIID.ToString();
        XPC_LOG_ALWAYS(("IID number is %s", iid));
        delete iid;
        XPC_LOG_ALWAYS(("InterfaceInfo @ %x", mInfo));
        uint16 methodCount = 0;
        if(depth)
        {
            uint16 i;
            nsIInterfaceInfo* parent;
            XPC_LOG_INDENT();
            mInfo->GetParent(&parent);
            XPC_LOG_ALWAYS(("parent @ %x", parent));
            mInfo->GetMethodCount(&methodCount);
            XPC_LOG_ALWAYS(("MethodCount = %d", methodCount));
            mInfo->GetConstantCount(&i);
            XPC_LOG_ALWAYS(("ConstantCount = %d", i));
            XPC_LOG_OUTDENT();
        }
        XPC_LOG_ALWAYS(("mXPCContext @ %x", mXPCContext));
        XPC_LOG_ALWAYS(("JSContext @ %x", GetJSContext()));
        XPC_LOG_ALWAYS(("mDescriptors @ %x count = %d", mDescriptors, methodCount));
        if(depth && mDescriptors && methodCount)
        {
            depth--;
            XPC_LOG_INDENT();
            for(uint16 i = 0; i < methodCount; i++)
            {
                XPC_LOG_ALWAYS(("Method %d is %s%s", \
                        i, IsReflectable(i) ? "":" NOT ","reflectable"));
            }
            XPC_LOG_OUTDENT();
            depth++;
        }
    XPC_LOG_OUTDENT();
#endif
    return NS_OK;
}
