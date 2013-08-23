/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef vm_SPSProfiler_h
#define vm_SPSProfiler_h

#include "mozilla/DebugOnly.h"
#include "mozilla/GuardObjects.h"

#include <stddef.h>

#include "jsscript.h"

#include "js/ProfilingStack.h"

/*
 * SPS Profiler integration with the JS Engine
 * https://developer.mozilla.org/en/Performance/Profiling_with_the_Built-in_Profiler
 *
 * The SPS profiler (found in tools/profiler) is an implementation of a profiler
 * which has the ability to walk the C++ stack as well as use instrumentation to
 * gather information. When dealing with JS, however, SPS needs integration
 * with the engine because otherwise it is very difficult to figure out what
 * javascript is executing.
 *
 * The current method of integration with SPS is a form of instrumentation:
 * every time a JS function is entered, a bit of information is pushed onto a
 * stack that SPS owns and maintains. This information is then popped at the end
 * of the JS function. SPS informs the JS engine of this stack at runtime, and
 * it can by turned on/off dynamically.
 *
 * The SPS stack has three parameters: a base pointer, a size, and a maximum
 * size. The stack is the ProfileEntry stack which will have information written
 * to it. The size location is a pointer to an integer which represents the
 * current size of the stack (number of valid frames). This size will be
 * modified when JS functions are called. The maximum specified is the maximum
 * capacity of the ProfileEntry stack.
 *
 * Throughout execution, the size of the stack recorded in memory may exceed the
 * maximum. The JS engine will not write any information past the maximum limit,
 * but it will still maintain the size of the stack. SPS code is aware of this
 * and iterates the stack accordingly.
 *
 * There is some information pushed on the SPS stack for every JS function that
 * is entered. First is a char* pointer of a description of what function was
 * entered. Currently this string is of the form "function (file:line)" if
 * there's a function name, or just "file:line" if there's no function name
 * available. The other bit of information is the relevant C++ (native) stack
 * pointer. This stack pointer is what enables the interleaving of the C++ and
 * the JS stack. Finally, throughout execution of the function, some extra
 * information may be updated on the ProfileEntry structure.
 *
 * = Profile Strings
 *
 * The profile strings' allocations and deallocation must be carefully
 * maintained, and ideally at a very low overhead cost. For this reason, the JS
 * engine maintains a mapping of all known profile strings. These strings are
 * keyed in lookup by a JSScript*, but are serialized with a JSFunction*,
 * JSScript* pair. A JSScript will destroy its corresponding profile string when
 * the script is finalized.
 *
 * For this reason, a char* pointer pushed on the SPS stack is valid only while
 * it is on the SPS stack. SPS uses sampling to read off information from this
 * instrumented stack, and it therefore copies the string byte for byte when a
 * JS function is encountered during sampling.
 *
 * = Native Stack Pointer
 *
 * The actual value pushed as the native pointer is NULL for most JS functions.
 * The reason for this is that there's actually very little correlation between
 * the JS stack and the C++ stack because many JS functions all run in the same
 * C++ frame, or can even go backwards in C++ when going from the JIT back to
 * the interpreter.
 *
 * To alleviate this problem, all JS functions push NULL as their "native stack
 * pointer" to indicate that it's a JS function call. The function RunScript(),
 * however, pushes an actual C++ stack pointer onto the SPS stack. This way when
 * interleaving C++ and JS, if SPS sees a NULL native stack pointer on the SPS
 * stack, it looks backwards for the first non-NULL pointer and uses that for
 * all subsequent NULL native stack pointers.
 *
 * = Line Numbers
 *
 * One goal of sampling is to get both a backtrace of the JS stack, but also
 * know where within each function on the stack execution currently is. For
 * this, each ProfileEntry has a 'pc' field to tell where its execution
 * currently is. This field is updated whenever a call is made to another JS
 * function, and for the JIT it is also updated whenever the JIT is left.
 *
 * This field is in a union with a uint32_t 'line' so that C++ can make use of
 * the field as well. It was observed that tracking 'line' via PCToLineNumber in
 * JS was far too expensive, so that is why the pc instead of the translated
 * line number is stored.
 *
 * As an invariant, if the pc is NULL, then the JIT is currently executing
 * generated code. Otherwise execution is in another JS function or in C++. With
 * this in place, only the top entry of the stack can ever have NULL as its pc.
 * Additionally with this invariant, it is possible to maintain mappings of JIT
 * code to pc which can be accessed safely because they will only be accessed
 * from a signal handler when the JIT code is executing.
 */

class JSFunction;

namespace js {

class ProfileEntry;

typedef HashMap<JSScript*, const char*, DefaultHasher<JSScript*>, SystemAllocPolicy>
        ProfileStringMap;

class SPSEntryMarker;

class SPSProfiler
{
    friend class SPSEntryMarker;

    JSRuntime            *rt;
    ProfileStringMap     strings;
    ProfileEntry         *stack_;
    uint32_t             *size_;
    uint32_t             max_;
    bool                 slowAssertions;
    uint32_t             enabled_;

    const char *allocProfileString(JSContext *cx, JSScript *script,
                                   JSFunction *function);
    void push(const char *string, void *sp, JSScript *script, jsbytecode *pc);
    void pop();

  public:
    SPSProfiler(JSRuntime *rt);
    ~SPSProfiler();

    uint32_t **addressOfSizePointer() {
        return &size_;
    }

    uint32_t *addressOfMaxSize() {
        return &max_;
    }

    ProfileEntry **addressOfStack() {
        return &stack_;
    }

    uint32_t *sizePointer() { return size_; }
    uint32_t maxSize() { return max_; }
    ProfileEntry *stack() { return stack_; }

    /* management of whether instrumentation is on or off */
    bool enabled() { JS_ASSERT_IF(enabled_, installed()); return enabled_; }
    bool installed() { return stack_ != NULL && size_ != NULL; }
    void enable(bool enabled);
    void enableSlowAssertions(bool enabled) { slowAssertions = enabled; }
    bool slowAssertionsEnabled() { return slowAssertions; }

    /*
     * Functions which are the actual instrumentation to track run information
     *
     *   - enter: a function has started to execute
     *   - updatePC: updates the pc information about where a function
     *               is currently executing
     *   - exit: this function has ceased execution, and no further
     *           entries/exits will be made
     */
    bool enter(JSContext *cx, JSScript *script, JSFunction *maybeFun);
    void exit(JSContext *cx, JSScript *script, JSFunction *maybeFun);
    void updatePC(JSScript *script, jsbytecode *pc) {
        if (enabled() && *size_ - 1 < max_) {
            JS_ASSERT(*size_ > 0);
            JS_ASSERT(stack_[*size_ - 1].script() == script);
            stack_[*size_ - 1].setPC(pc);
        }
    }

    /* Enter a C++ function. */
    void enterNative(const char *string, void *sp);
    void exitNative() { pop(); }

    jsbytecode *ipToPC(JSScript *script, size_t ip) { return NULL; }

    void setProfilingStack(ProfileEntry *stack, uint32_t *size, uint32_t max);
    const char *profileString(JSContext *cx, JSScript *script, JSFunction *maybeFun);
    void onScriptFinalized(JSScript *script);

    /* meant to be used for testing, not recommended to call in normal code */
    size_t stringsCount() { return strings.count(); }
    void stringsReset() { strings.clear(); }

    uint32_t *addressOfEnabled() {
        return &enabled_;
    }
};

/*
 * This class is used in RunScript() to push the marker onto the sampling stack
 * that we're about to enter JS function calls. This is the only time in which a
 * valid stack pointer is pushed to the sampling stack.
 */
class SPSEntryMarker
{
  public:
    SPSEntryMarker(JSRuntime *rt
                   MOZ_GUARD_OBJECT_NOTIFIER_PARAM);
    ~SPSEntryMarker();

  private:
    SPSProfiler *profiler;
    mozilla::DebugOnly<uint32_t> size_before;
    MOZ_DECL_USE_GUARD_OBJECT_NOTIFIER
};

/*
 * SPS is the profiling backend used by the JS engine to enable time profiling.
 * More information can be found in vm/SPSProfiler.{h,cpp}. This class manages
 * the instrumentation portion of the profiling for JIT code.
 *
 * The instrumentation tracks entry into functions, leaving those functions via
 * a function call, reentering the functions from a function call, and exiting
 * the functions from returning. This class also handles inline frames and
 * manages the instrumentation which needs to be attached to them as well.
 *
 * The basic methods which emit instrumentation are at the end of this class,
 * and the management functions are all described in the middle.
 */
template<class Assembler, class Register>
class SPSInstrumentation
{
    /* Because of inline frames, this is a nested structure in a vector */
    struct FrameState {
        JSScript *script; // script for this frame, NULL if not pushed yet
        bool skipNext;    // should the next call to reenter be skipped?
        int  left;        // number of leave() calls made without a matching reenter()
    };

    SPSProfiler *profiler_; // Instrumentation location management

    Vector<FrameState, 1, SystemAllocPolicy> frames;
    FrameState *frame;

  public:
    /*
     * Creates instrumentation which writes information out the the specified
     * profiler's stack and constituent fields.
     */
    SPSInstrumentation(SPSProfiler *profiler)
      : profiler_(profiler), frame(NULL)
    {
        enterInlineFrame();
    }

    /* Small proxies around SPSProfiler */
    bool enabled() { return profiler_ && profiler_->enabled(); }
    SPSProfiler *profiler() { JS_ASSERT(enabled()); return profiler_; }
    bool slowAssertions() { return enabled() && profiler_->slowAssertionsEnabled(); }

    /* Signals an inline function returned, reverting to the previous state */
    void leaveInlineFrame() {
        if (!enabled())
            return;
        JS_ASSERT(frame->left == 0);
        JS_ASSERT(frame->script != NULL);
        frames.shrinkBy(1);
        JS_ASSERT(frames.length() > 0);
        frame = &frames[frames.length() - 1];
    }

    /* Saves the current state and assumes a fresh one for the inline function */
    bool enterInlineFrame() {
        if (!enabled())
            return true;
        JS_ASSERT_IF(frame != NULL, frame->script != NULL);
        JS_ASSERT_IF(frame != NULL, frame->left == 1);
        if (!frames.growBy(1))
            return false;
        frame = &frames[frames.length() - 1];
        frame->script = NULL;
        frame->skipNext = false;
        frame->left = 0;
        return true;
    }

    /* Number of inline frames currently active (doesn't include original one) */
    unsigned inliningDepth() {
        return frames.length() - 1;
    }

    /*
     * When debugging or with slow assertions, sometimes a C++ method will be
     * invoked to perform the pop operation from the SPS stack. When we leave
     * JIT code, we need to record the current PC, but upon reentering JIT code,
     * no update back to NULL should happen. This method exists to flag this
     * behavior. The next leave() will emit instrumentation, but the following
     * reenter() will be a no-op.
     */
    void skipNextReenter() {
        /* If we've left the frame, the reenter will be skipped anyway */
        if (!enabled() || frame->left != 0)
            return;
        JS_ASSERT(frame->script);
        JS_ASSERT(!frame->skipNext);
        frame->skipNext = true;
    }

    /*
     * In some cases, a frame needs to be flagged as having been pushed, but no
     * instrumentation should be emitted. This updates internal state to flag
     * that further instrumentation should actually be emitted.
     */
    void setPushed(JSScript *script) {
        if (!enabled())
            return;
        JS_ASSERT(frame->left == 0);
        frame->script = script;
    }

    /*
     * Flags entry into a JS function for the first time. Before this is called,
     * no instrumentation is emitted, but after this instrumentation is emitted.
     */
    bool push(JSContext *cx, JSScript *script, Assembler &masm, Register scratch) {
        if (!enabled())
            return true;
        const char *string = profiler_->profileString(cx, script,
                                                      script->function());
        if (string == NULL)
            return false;
        masm.spsPushFrame(profiler_, string, script, scratch);
        setPushed(script);
        return true;
    }

    /*
     * Signifies that C++ performed the push() for this function. C++ always
     * sets the current PC to something non-null, however, so as soon as JIT
     * code is reentered this updates the current pc to NULL.
     */
    void pushManual(JSScript *script, Assembler &masm, Register scratch) {
        if (!enabled())
            return;
        masm.spsUpdatePCIdx(profiler_, ProfileEntry::NullPCIndex, scratch);
        setPushed(script);
    }

    /*
     * Signals that the current function is leaving for a function call. This
     * can happen both on JS function calls and also calls to C++. This
     * internally manages how many leave() calls have been seen, and only the
     * first leave() emits instrumentation. Similarly, only the last
     * corresponding reenter() actually emits instrumentation.
     */
    void leave(jsbytecode *pc, Assembler &masm, Register scratch) {
        if (enabled() && frame->script && frame->left++ == 0) {
            JS_ASSERT(frame->script->code <= pc &&
                      pc < frame->script->code + frame->script->length);
            masm.spsUpdatePCIdx(profiler_, pc - frame->script->code, scratch);
        }
    }

    /*
     * Flags that the leaving of the current function has returned. This tracks
     * state with leave() to only emit instrumentation at proper times.
     */
    void reenter(Assembler &masm, Register scratch) {
        if (!enabled() || !frame->script || frame->left-- != 1)
            return;
        if (frame->skipNext)
            frame->skipNext = false;
        else
            masm.spsUpdatePCIdx(profiler_, ProfileEntry::NullPCIndex, scratch);
    }

    /*
     * Signifies exiting a JS frame, popping the SPS entry. Because there can be
     * multiple return sites of a function, this does not cease instrumentation
     * emission.
     */
    void pop(Assembler &masm, Register scratch) {
        if (enabled()) {
            JS_ASSERT(frame->left == 0);
            JS_ASSERT(frame->script);
            masm.spsPopFrame(profiler_, scratch);
        }
    }
};

} /* namespace js */

#endif /* vm_SPSProfiler_h */
