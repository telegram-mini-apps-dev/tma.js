import { logger } from '@/debug/debug.js';
import { EventEmitter } from '@/events/event-emitter/EventEmitter.js';
import { onWindow } from '@/events/onWindow.js';
import { createCleanup } from '@/misc/createCleanup.js';
import { boolean } from '@/parsing/parsers/boolean.js';
import { json } from '@/parsing/parsers/json.js';
import { number } from '@/parsing/parsers/number.js';
import { rgb } from '@/parsing/parsers/rgb.js';
import { string } from '@/parsing/parsers/string.js';
import { toRecord } from '@/parsing/toRecord.js';
import type { RGB } from '@/colors/types.js';

import { type MiniAppsMessage, parseMessage } from '../../parseMessage.js';
import { cleanupEventHandlers } from '../event-handlers/cleanupEventHandlers.js';
import { defineEventHandlers } from '../event-handlers/defineEventHandlers.js';
import type {
  MiniAppsEventName,
  MiniAppsEventPayload,
  MiniAppsEventEmitter,
  MiniAppsEvents,
} from '../types.js';

/**
 * Parsers for each Mini Apps event.
 *
 * This map should be cleaned
 */
const parsers: {
  [E in MiniAppsEventName]?: {
    parse(value: unknown): MiniAppsEventPayload<E>;
  }
} = {
  clipboard_text_received: json({
    req_id: string(),
    data: (value) => (value === null ? value : string().optional().parse(value)),
  }),
  custom_method_invoked: json({
    req_id: string(),
    result: (value) => value,
    error: string().optional(),
  }),
  invoice_closed: json({ slug: string(), status: string() }),
  phone_requested: json({ status: string() }),
  popup_closed: {
    parse(value) {
      return json({
        button_id: (value) => (
          value === null || value === undefined
            ? undefined
            : string().parse(value)
        ),
      }).parse(value ?? {});
    },
  },
  qr_text_received: json({ data: string().optional() }),
  theme_changed: json({
    theme_params: (value) => {
      const parser = rgb().optional();

      return Object
        .entries(toRecord(value))
        .reduce<Partial<Record<string, RGB>>>((acc, [k, v]) => {
          acc[k] = parser.parse(v);
          return acc;
        }, {});
    },
  }),
  viewport_changed: json({
    height: number(),
    width: (value) => (
      value === null || value === undefined
        ? window.innerWidth
        : number().parse(value)
    ),
    is_state_stable: boolean(),
    is_expanded: boolean(),
  }),
  write_access_requested: json({ status: string() }),
};

/**
 * Creates new event emitter, which handles events from the Telegram application.
 */
export function createMiniAppsEventEmitter(): [
  /**
   * Created event emitter.
   */
  emitter: MiniAppsEventEmitter,
  /**
   * Function to dispose created emitter.
   */
  dispose: () => void,
] {
  // We use this event emitter for better developer experience, using the subscribe method.
  const subEmitter = new EventEmitter<{ event: any[] }>();

  // Event emitter processing all the incoming events.
  const mainEmitter = new EventEmitter<MiniAppsEvents>();

  mainEmitter.subscribe(event => {
    subEmitter.emit('event', { name: event.event, payload: event.args[0] });
  });

  // Define event handles, which will proxy native method calls to their web version.
  defineEventHandlers();

  // List of cleanup functions, which should be called on dispose.
  const [, cleanup] = createCleanup(
    // Don't forget to remove created handlers.
    cleanupEventHandlers,
    // Add "resize" event listener to make sure, we always have fresh viewport information.
    // Desktop version of Telegram is sometimes not sending the viewport_changed
    // event. For example, when the MainButton is shown. That's why we should
    // add our own listener to make sure, viewport information is always fresh.
    // Issue: https://github.com/Telegram-Mini-Apps/tma.js/issues/10
    onWindow('resize', () => {
      mainEmitter.emit('viewport_changed', {
        width: window.innerWidth,
        height: window.innerHeight,
        is_state_stable: true,
        is_expanded: true,
      });
    }),
    // Add listener, which handles events sent from the Telegram web application and also events
    // generated by the local emitEvent function.
    onWindow('message', (event) => {
      // Ignore non-parent window messages.
      if (event.source !== window.parent) {
        return;
      }

      // Parse incoming event data.
      let message: MiniAppsMessage;
      try {
        message = parseMessage(event.data);
      } catch {
        // We ignore incorrect messages as they could be generated by any other code.
        return;
      }

      const { eventType, eventData } = message;
      const parser = parsers[eventType as keyof typeof parsers];

      try {
        const data = parser ? parser.parse(eventData) : eventData;
        mainEmitter.emit(...(data ? [eventType, data] : [eventType]) as [any, any]);
      } catch (cause) {
        logger.error(
          `An error occurred processing the "${eventType}" event from the Telegram application. Please, file an issue here: https://github.com/Telegram-Mini-Apps/tma.js/issues/new/choose`,
          message,
          cause,
        );
      }
    }),
    // Clear emitters.
    () => subEmitter.clear(),
    () => mainEmitter.clear(),
  );

  return [{
    on: mainEmitter.on.bind(mainEmitter),
    off: mainEmitter.on.bind(mainEmitter),
    subscribe(listener) {
      return subEmitter.on('event', listener);
    },
    unsubscribe(listener) {
      subEmitter.off('event', listener);
    },
    get count() {
      return mainEmitter.count + subEmitter.count;
    },
  }, cleanup];
}
