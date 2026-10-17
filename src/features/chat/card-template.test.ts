import { describe, expect, it } from "vitest";
import { renderCardTemplate } from "./card-template";

describe("renderCardTemplate", () => {
  it("renders common card aliases only at runtime", () => {
    expect(
      renderCardTemplate(
        "<START> {{char}} / {{character}} / <BOT> meets {{user}} / {{persona}} / %user%.",
        { characterName: "Mara", userName: "Ari" },
      ),
    ).toBe("Mara / Mara / Mara meets Ari / Ari / Ari.");
  });

  it("uses safe display fallbacks", () => {
    expect(renderCardTemplate("Hello {{user}}, I am {{char}}.", { characterName: "Nia" }))
      .toBe("Hello you, I am Nia.");
  });
});
