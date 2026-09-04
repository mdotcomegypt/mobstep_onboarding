import { drupal } from "../lib/drupal.ts";
import { capacity, ensureAndroidApp, FirebaseError } from "../lib/firebase.ts";
import { report } from "../lib/progress.ts";
import { trace } from "../lib/trace.ts";
import { loadFacts, mutateFacts } from "./facts.ts";

/**
 * Getting an app ready to build for Android.
 *
 * The build cannot compile a package Firebase has never heard of — the
 * google-services plugin is applied unconditionally — so this runs first and
 * turns a four-minute Gradle failure into an instant sentence.
 *
 * It is deliberately NOT part of the default onboarding arc. The web app is the
 * deliverable; this runs only when an owner asks for an APK, because registering
 * a Firebase app is a real, roughly-irreversible act against a project with a
 * hard cap on how many it can hold.
 */

export interface AndroidReadiness {
  ready: boolean;
  applicationId?: string;
  /** Set when we registered rather than reused. */
  registered?: boolean;
  reason?: string;
}

export async function prepareAndroid(sessionId: number, appId: number): Promise<AndroidReadiness> {
  let identity;
  try {
    identity = await drupal.androidIdentity(appId);
  } catch (error) {
    return { ready: false, reason: (error as Error).message };
  }

  if (identity.has_google_services) {
    return { ready: true, applicationId: identity.application_id };
  }

  // Check the room before asking for more. A project that is full fails the
  // create with a message about quota, at the exact moment a merchant is
  // waiting — better to say it plainly and leave their data untouched.
  let room;
  try {
    room = await capacity();
  } catch (error) {
    if (error instanceof FirebaseError && error.status === 0) {
      // Not configured. That is an operator problem, not a merchant one.
      return { ready: false, reason: error.message };
    }
    return { ready: false, reason: (error as Error).message };
  }

  if (room.room <= 0) {
    trace("android.no_capacity", { project: room.project, android: room.android }, { sessionId });
    return {
      ready: false,
      reason:
        `The Firebase project "${room.project}" is full (${room.android} of ${room.limit} apps), ` +
        "so no new Android app can be registered until the limit is raised or a " +
        "second project is added.",
    };
  }

  const facts = await loadFacts(sessionId);
  report({ label: "Registering your app with Firebase" });

  try {
    const registration = await ensureAndroidApp(
      identity.application_id,
      facts.business.name ?? identity.package,
    );
    await drupal.setGoogleServices(appId, registration.config);

    await mutateFacts(sessionId, (f) => {
      f.android = {
        requested: true,
        applicationId: identity.application_id,
        firebaseAppId: registration.appId,
        registeredAt: new Date().toISOString(),
      };
    });

    trace("android.ready", {
      appId,
      applicationId: identity.application_id,
      firebaseAppId: registration.appId,
      reused: registration.reused,
    }, { sessionId });

    return { ready: true, applicationId: identity.application_id, registered: !registration.reused };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace("android.prepare_failed", { appId, message: message.slice(0, 300) }, { sessionId });
    return { ready: false, reason: message };
  }
}
