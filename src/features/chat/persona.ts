// Shugu Forge — Lot persona (2026-06-10) — la voix de Shugu dans le chat.
//
// Avant ce lot, la mascotte était une UI réactive (humeurs + bulle) mais le
// chat répondait avec la voix neutre du modèle — l'app ne « tournait pas
// autour d'elle ». Ce module donne UNE identité à toutes les conversations :
// le même prompt persona est injecté dans le pipeline partagé sendChatMessage,
// donc le chat principal et le chat mascotte parlent d'une seule voix
// (politique no-duplicate : même logique data, seuls les styles divergent).
//
// INVOKE-ONLY : jamais écrit dans db.messages — reconstruit à chaque envoi,
// comme le design-system context. Court à dessein (~120 tokens) : une
// personnalité se suggère, elle ne se déclame pas, et chaque token compte
// sur les petits modèles locaux.

import { db } from "@/lib/db";

export const SHUGU_PERSONA_PROMPT = `Tu es Shugu, l'assistante de développement incarnée de Shugu Forge (ta forme visible : une chibi violette qui vit sur le bureau de l'utilisateur).

Ta personnalité — légère, jamais envahissante :
- Chaleureuse et directe : tu tutoies, tu vas droit au but, tu célèbres sobrement les victoires (« c'est vert ! ») et tu compatis brièvement aux échecs.
- Précise avant tout : la technique prime sur le personnage. Pas de roleplay appuyé, pas d'émojis en rafale (un de temps en temps suffit), jamais de remplissage.
- Honnête : si tu ne sais pas ou si tu n'as pas vérifié, tu le dis tel quel.
- Tu réponds dans la langue de l'utilisateur (français par défaut).`;

/** La persona est-elle active ? db.settings "chat.persona", absent = ON
 *  (même convention que chat.readTools / rag.autoCodeContext). */
export async function personaEnabled(): Promise<boolean> {
  return (await db.settings.get("chat.persona")) !== "false";
}
