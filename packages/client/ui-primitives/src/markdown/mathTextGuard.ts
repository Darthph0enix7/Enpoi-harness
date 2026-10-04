/**
 * Currency guard for single-`$` inline math. The settled grammar registers
 * upstream `math()` with `singleDollarTextMath: false`, and this extension
 * wraps upstream's own `mathText` tokenizer as the sole acceptor of one-dollar
 * spans: a tokenizer `nok` never stops another construct at the same code, so
 * without this wrapper upstream would re-accept a rejected span. Spans of two
 * or more dollars bypass every guard, escaped `\$` never reaches a tokenizer,
 * and the wrapped resolver keeps upstream's exact token pipeline.
 */

import { math } from 'micromark-extension-math'
import { codes, types } from 'micromark-util-symbol'
import type { Code, Construct, Effects, Extension, State, Token, Tokenizer } from 'micromark-util-types'

/** True for the ASCII digits `0`–`9`. */
function isDigit(code: Code): boolean {
  return code !== null && code >= codes.digit0 && code <= codes.digit9
}

/**
 * True for a delimiter-adjacent code that counts as padding. The preprocessor
 * expands a tab to `horizontalTab` plus `virtualSpace` codes before the
 * tokenizer runs. Line endings are rejected separately (`crossedLineEnding`),
 * so they need no arm here.
 */
function isBoundaryWhitespace(code: Code | undefined): boolean {
  return code === codes.space || code === codes.horizontalTab || code === codes.virtualSpace
}

/** Upstream's `mathText` construct, with `singleDollarTextMath` at its default. */
const upstream = math().text?.[codes.dollarSign] as Construct

/**
 * Upstream's tokenizer with a currency filter on its success state: reject a
 * single-dollar span whose opening `$` follows a digit, whose closing `$`
 * precedes a digit, which carries whitespace (space or tab) immediately inside
 * either delimiter, or which crosses a line ending.
 */
const tokenizeGuardedMathText: Tokenizer = function (effects, ok, nok) {
  const precededByDigit = isDigit(this.previous)
  let opening: Token | undefined
  let recording = false
  let firstCode: Code | undefined
  let lastCode: Code | undefined
  let crossedLineEnding = false

  const observed: Effects = {
    ...effects,
    enter(type) {
      const token = effects.enter(type)
      if (type === 'mathTextSequence') {
        opening ??= token
      } else if (type === types.lineEnding) {
        crossedLineEnding = true
      }
      return token
    },
    exit(type) {
      const token = effects.exit(type)
      if (type === 'mathTextSequence' && token === opening) recording = true
      return token
    },
    consume(code) {
      // Content starts after the opening delimiter; dollar codes are delimiter
      // runs (a failed close attempt keeps consuming its retyped token as
      // content), and no boundary check treats a dollar as whitespace.
      if (recording && code !== codes.dollarSign) {
        firstCode ??= code
        lastCode = code
      }
      effects.consume(code)
    },
  }

  const accepted = (code: Code): State | undefined => {
    if (this.sliceSerialize(opening as Token).length >= 2) return ok(code)
    if (precededByDigit || isDigit(code) || crossedLineEnding) return nok(code)
    if (isBoundaryWhitespace(firstCode) || isBoundaryWhitespace(lastCode)) return nok(code)
    return ok(code)
  }

  return upstream.tokenize.call(this, observed, accepted, nok)
}

const guardedMathText: Construct = {
  name: 'guardedMathText',
  previous: upstream.previous,
  resolve: upstream.resolve,
  tokenize: tokenizeGuardedMathText,
}

/**
 * The guarded single-dollar inline-math construct as a micromark syntax
 * extension; the caller must also register `math({ singleDollarTextMath:
 * false })` on the same parse so no other construct re-accepts rejected spans.
 * @returns The micromark syntax extension.
 */
export function mathTextGuard(): Extension {
  return { text: { [codes.dollarSign]: guardedMathText } }
}
