/* -*- Mode: java; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public
 * License Version 1.1 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of
 * the License at http://www.mozilla.org/NPL/
 *
 * Software distributed under the License is distributed on an "AS
 * IS" basis, WITHOUT WARRANTY OF ANY KIND, either express oqr
 * implied. See the License for the specific language governing
 * rights and limitations under the License.
 *
 * The Original Code is Rhino code, released
 * May 6, 1999.
 *
 * The Initial Developer of the Original Code is Netscape
 * Communications Corporation.  Portions created by Netscape are
 * Copyright (C) 1997-1999 Netscape Communications Corporation. All
 * Rights Reserved.
 *
 * Contributor(s):
 * Norris Boyd
 *
 * Alternatively, the contents of this file may be used under the
 * terms of the GNU Public License (the "GPL"), in which case the
 * provisions of the GPL are applicable instead of those above.
 * If you wish to allow use of your version of this file only
 * under the terms of the GPL and not to allow others to use your
 * version of this file under the NPL, indicate your decision by
 * deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL.  If you do not delete
 * the provisions above, a recipient may use your version of this
 * file under either the NPL or the GPL.
 */

package org.mozilla.javascript;
import java.lang.reflect.InvocationTargetException;

/**
 * A wrapper for runtime exceptions.
 *
 * Used by the JavaScript runtime to wrap and propagate exceptions that occur
 * during runtime.
 *
 * @author Norris Boyd
 */
public class WrappedException extends EvaluatorException implements Wrapper {

    /**
     * Create a new exception wrapped around an existing exception.
     *
     * @param exception the exception to wrap
     */
    public WrappedException(Throwable exception) {
        super(exception.getMessage());
        this.exception = exception.fillInStackTrace();
    }

    /**
     * Get the message for the exception.
     *
     * Delegates to the wrapped exception.
     */
    public String getMessage() {
        return "WrappedException of " + exception.toString();
    }

    /**
     * Gets the localized message.
     *
     * Delegates to the wrapped exception.
     */
    public String getLocalizedMessage() {
        return "WrappedException of " + exception.getLocalizedMessage();
    }

    /**
     * Get the wrapped exception.
     *
     * @return the exception that was presented as a argument to the
     *         constructor when this object was created
     */
    public Throwable getWrappedException() {
        return exception;
    }

    /**
     * Get the wrapped exception.
     *
     * @return the exception that was presented as a argument to the
     *         constructor when this object was created
     */
    public Object unwrap() {
        return exception;
    }

    /**
     * Wrap an exception.
     *
     * Provides special cases for EvaluatorExceptions (which are returned
     * as-is), and InvocationTargetExceptions (which are unwrapped and
     * passed to a recursive call to wrapException).<p>
     *
     * Otherwise the exception is simply wrapped in a WrappedException.
     */
    public static EvaluatorException wrapException(Throwable e) {
        if ((e instanceof InvocationTargetException))
            e = ((InvocationTargetException) e).getTargetException();
        if (e instanceof EvaluatorException)
            return (EvaluatorException) e;
        return new WrappedException(e);
    }

    private Throwable exception;
}
