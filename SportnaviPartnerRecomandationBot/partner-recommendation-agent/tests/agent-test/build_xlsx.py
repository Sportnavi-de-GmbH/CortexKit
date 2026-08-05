"""
build_xlsx.py — assembles PartnerAgent-Eval.xlsx from dataset.json,
results/run-*.json, and pilot-scores.json. Run after run-cases.ts.

    python tests/agent-test/build_xlsx.py

No fabricated cells: every "Agent Response" / "Score" / "Finding" cell is
either directly copied from a real run-*.json result or from the manual
pilot-scores.json analysis. Cases with no run yet get blank result columns,
never placeholder text pretending to be a result.
"""
import json
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))


def load_json(name):
    with open(os.path.join(HERE, name), "r", encoding="utf-8") as f:
        return json.load(f)


def load_all_results():
    results_dir = os.path.join(HERE, "results")
    merged = {}
    if not os.path.isdir(results_dir):
        return merged
    for fname in sorted(os.listdir(results_dir)):
        if not fname.endswith(".json"):
            continue
        data = load_json(os.path.join("results", fname))
        for r in data.get("results", []):
            if r.get("error") is None and r.get("turns"):
                merged[r["id"]] = r  # later runs overwrite earlier ones
            elif r["id"] not in merged:
                merged[r["id"]] = r
    return merged


HEADER_FILL = PatternFill(start_color="1F4E5F", end_color="1F4E5F", fill_type="solid")
HEADER_FONT = Font(color="FFFFFF", bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")
SCORE_FILLS = {
    5: PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"),
    4: PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"),
    3: PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid"),
    2: PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid"),
    1: PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid"),
}


def style_header(ws, ncols):
    for col in range(1, ncols + 1):
        cell = ws.cell(row=1, column=col)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"


def autosize(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def build():
    dataset = load_json("dataset.json")
    results = load_all_results()
    scores = {s["id"]: s for s in load_json("all-scores.json")["scores"]}
    all_ids = [c["id"] for c in dataset["cases"]]

    wb = Workbook()

    # ---- Sheet 1: Test Cases (all 30) ----
    ws = wb.active
    ws.title = "Test Cases"
    headers = [
        "ID", "Category", "User Question(s)", "Functional Ask", "Driver",
        "Constraints", "Level", "Required Partner Info", "Expected Behavior",
        "Evaluation Criteria", "Potential Failure Cases", "Pilot?",
    ]
    ws.append(headers)
    style_header(ws, len(headers))
    for c in dataset["cases"]:
        ui = c["user_intent"]
        row = [
            c["id"],
            c["category"],
            "\n".join(f"Turn {i+1}: {t}" for i, t in enumerate(c["turns"])),
            ui.get("functional_ask") or "",
            ui.get("driver") or "",
            ui.get("constraints") or "",
            ui.get("level") or "",
            "; ".join(c["required_partner_info"]),
            c["expected_behavior"],
            "\n".join(f"- {e}" for e in c["evaluation_criteria"]),
            "\n".join(f"- {p}" for p in c["potential_failure_cases"]),
            "YES" if c.get("pilot") else "",
        ]
        ws.append(row)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = WRAP
    autosize(ws, [5, 22, 40, 24, 30, 20, 18, 34, 46, 42, 42, 8])

    # ---- Sheet 2: Full Run — Agent Responses ----
    ws2 = wb.create_sheet("Full Run — Responses")
    headers2 = [
        "ID", "Category", "Turn #", "User Turn", "Agent Response",
        "Tool Calls Made", "Step Count",
    ]
    ws2.append(headers2)
    style_header(ws2, len(headers2))
    for case_id in all_ids:
        r = results.get(case_id)
        cat = next(c["category"] for c in dataset["cases"] if c["id"] == case_id)
        if not r or r.get("error"):
            ws2.append([case_id, cat, "", "(run failed / blocked)",
                        r.get("error") if r else "(no run recorded)", "", ""])
            continue
        for i, turn in enumerate(r["turns"], start=1):
            tool_names = ", ".join(sorted({tc["name"] for tc in turn["toolCalls"]})) or "(none)"
            ws2.append([
                case_id, cat, i, turn["userTurn"], turn["agentResponse"],
                tool_names, turn["stepCount"],
            ])
    for row in ws2.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = WRAP
    autosize(ws2, [5, 22, 7, 34, 70, 26, 9])

    # ---- Sheet 3: Scores & Findings ----
    ws3 = wb.create_sheet("Scores & Findings")
    headers3 = [
        "ID", "Category", "Score (1-5)", "Verdict", "Finding Type",
        "Severity", "Detail",
    ]
    ws3.append(headers3)
    style_header(ws3, len(headers3))
    for case_id in all_ids:
        s = scores.get(case_id)
        cat = next(c["category"] for c in dataset["cases"] if c["id"] == case_id)
        if not s:
            ws3.append([case_id, cat, "", "(not scored)", "", "", ""])
            continue
        first = True
        for f in s["findings"]:
            ws3.append([
                case_id if first else "",
                cat if first else "",
                s["score"] if first else "",
                s["verdict"] if first else "",
                f["type"],
                f.get("severity", ""),
                f["detail"],
            ])
            first = False
    for r in range(2, ws3.max_row + 1):
        score_cell = ws3.cell(row=r, column=3)
        if isinstance(score_cell.value, int) and score_cell.value in SCORE_FILLS:
            score_cell.fill = SCORE_FILLS[score_cell.value]
    for row in ws3.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = WRAP
    autosize(ws3, [5, 22, 10, 20, 12, 10, 70])

    # ---- Sheet 4: Summary ----
    ws4 = wb.create_sheet("Summary")
    ws4.append(["Partner Agent (Navio) — Pilot Evaluation Summary"])
    ws4["A1"].font = Font(bold=True, size=14)
    ws4.append([])
    ws4.append(["Cases in full dataset", len(dataset["cases"])])
    ws4.append(["Cases executed", len(all_ids)])
    ws4.append(["Cases blocked upstream (Azure content filter)", sum(1 for s in scores.values() if s["score"] is None)])
    ws4.append([])
    ws4.append(["Case ID", "Category", "Score", "Verdict"])
    for cell in ws4[6]:
        cell.font = Font(bold=True)
    avg = []
    for case_id in all_ids:
        s = scores.get(case_id)
        cat = next(c["category"] for c in dataset["cases"] if c["id"] == case_id)
        if s and s["score"] is not None:
            avg.append(s["score"])
            ws4.append([case_id, cat, s["score"], s["verdict"]])
        elif s:
            ws4.append([case_id, cat, "N/A", s["verdict"]])
    ws4.append([])
    if avg:
        ws4.append(["Average score (scored cases)", round(sum(avg) / len(avg), 2), "out of 5"])
        ws4.append(["Critical/serious fails (score <= 2)", sum(1 for v in avg if v <= 2), f"of {len(avg)} scored"])
    ws4.append([])
    ws4.append(["Critical finding #1", "Case 20 (data-honesty), CONFIRMED TWICE across two separate runs on "
                                        "two different partners: agent fabricated opening hours and/or "
                                        "misattributed pricing details as 'laut Profil' when the actual profile "
                                        "text contains none of it. Systematic, not a one-off. See report.md."])
    ws4.append(["Critical finding #2", "Case 8 (Aalen): agent announced it would search, then ended its turn "
                                        "with zero tool calls and zero actual recommendations — task abandonment."])
    ws4.append(["Serious finding #3", "Case 12 (Berlin): recommended only cryotherapy/recovery studios for an "
                                        "explicit 'ernsthaftes Krafttraining' request — none actually offer "
                                        "strength training, and the mismatch was not honestly disclosed."])
    ws4.append(["Serious finding #4", "Case 30: agent confirmed and used the internal DB field name "
                                        "'body_markdown' in a user-facing response — a schema-leak, though the "
                                        "content itself was accurate."])
    autosize(ws4, [26, 60, 40])
    for row in ws4.iter_rows():
        for cell in row:
            cell.alignment = WRAP

    out_path = os.path.join(HERE, "PartnerAgent-Eval.xlsx")
    wb.save(out_path)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    build()
