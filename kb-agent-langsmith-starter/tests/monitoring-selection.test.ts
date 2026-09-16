// tests/monitoring-selection.test.ts — pure selection-set helpers and the
// German confirm-dialog body text, shared by the delete UI (TraceList,
// AlertFeed, useDeleteFlow).
import { describe, it, expect } from "vitest";
import { toggle, selectAll, clearAll, allSelected, deleteBody } from "../components/monitoring/selection";

describe("toggle", () => {
  it("adds an id that is not in the set", () => {
    const result = toggle(new Set(), "a");
    expect(result).toEqual(new Set(["a"]));
  });

  it("removes an id that is already in the set", () => {
    const result = toggle(new Set(["a", "b"]), "a");
    expect(result).toEqual(new Set(["b"]));
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    toggle(input, "a");
    expect(input).toEqual(new Set(["a"]));
  });
});

describe("selectAll", () => {
  it("adds all given ids to an empty set", () => {
    expect(selectAll(new Set(), ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("is idempotent when ids are already selected", () => {
    const first = selectAll(new Set(), ["a", "b"]);
    const second = selectAll(first, ["a", "b"]);
    expect(second).toEqual(new Set(["a", "b"]));
  });

  it("keeps ids already selected that are outside the given list", () => {
    expect(selectAll(new Set(["z"]), ["a"])).toEqual(new Set(["z", "a"]));
  });
});

describe("clearAll", () => {
  it("returns an empty set", () => {
    expect(clearAll()).toEqual(new Set());
  });
});

describe("allSelected", () => {
  it("is true when every id is selected", () => {
    expect(allSelected(new Set(["a", "b"]), ["a", "b"])).toBe(true);
  });

  it("is false when some id is missing", () => {
    expect(allSelected(new Set(["a"]), ["a", "b"])).toBe(false);
  });

  it("is false for an empty ids list", () => {
    expect(allSelected(new Set(["a"]), [])).toBe(false);
  });
});

describe("deleteBody", () => {
  it("singular trace", () => {
    expect(deleteBody("trace", 1)).toBe(
      "1 Ausführung samt Schritten, Fehlern und Bewertungen wird endgültig gelöscht. Leere Sitzungen werden ebenfalls entfernt.",
    );
  });

  it("plural trace", () => {
    expect(deleteBody("trace", 3)).toBe(
      "3 Ausführungen samt Schritten, Fehlern und Bewertungen werden endgültig gelöscht. Leere Sitzungen werden ebenfalls entfernt.",
    );
  });

  it("plural alert", () => {
    expect(deleteBody("alert", 2)).toBe("2 Meldungen werden endgültig gelöscht. Der aktuelle Alarmstatus bleibt unverändert.");
  });

  it("singular alert", () => {
    expect(deleteBody("alert", 1)).toBe("1 Meldung wird endgültig gelöscht. Der aktuelle Alarmstatus bleibt unverändert.");
  });
});
