import type { KutxabankLocalCard } from "../cards/kutxabank-sync-service.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

interface CardsConfigFile {
  version: 1;
  cards: Array<Pick<KutxabankLocalCard, "id" | "alias" | "last4" | "syncEnabled" | "balance">>;
}

export class CardsConfigStore {
  public constructor(private readonly path: string) {}

  public async save(cards: KutxabankLocalCard[]): Promise<void> {
    const content: CardsConfigFile = {
      version: 1,
      cards: cards.map(({ id, alias, last4, syncEnabled, balance }) => ({
        id, alias, last4, syncEnabled, balance
      }))
    };
    await writeJsonAtomically(this.path, content);
  }
}
