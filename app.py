# -*- coding: utf-8 -*-
import os, json, base64, random, time, tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS
import google.generativeai as genai

app = Flask(__name__)
CORS(app)

genai.configure(api_key="AIzaSyDGjzq3KQ0FmpefIk3S4hUC54gLBMtvsqM")
model = genai.GenerativeModel("gemini-1.5-pro")

# ─── Prompts ─────────────────────────────────────────────────────────────────

VISION_PROMPT = """You are an expert cricket analyst with 20 years of experience covering international cricket.
Analyze this cricket match image carefully.

Return ONLY valid JSON — no markdown, no explanation, no extra text:
{
  "shot_type": "one of: cover drive | pull shot | sweep | cut shot | defensive block | straight drive | hook shot | flick | glance | no shot detected",
  "batsman_handedness": "right-handed | left-handed | unknown",
  "ball_direction": "off side | on side | straight | yorker length | unknown",
  "field_zone": "one of: cover | extra cover | mid-off | straight | mid-on | square leg | fine leg | point | third man | unknown",
  "estimated_speed_kmh": <integer between 80 and 155>,
  "boundary_probability": <float 0.0 to 1.0>,
  "wicket_probability": <float 0.0 to 1.0>,
  "delivery_type": "full | good length | short | yorker | bouncer | unknown",
  "confidence": <float 0.0 to 1.0>,
  "event_description": "<one vivid sentence describing exactly what is happening in the image>"
}

Rules:
- estimated_speed_kmh: estimate from ball blur, body positioning, and delivery context. Fast bowlers: 130-155, medium: 110-130, spin: 80-100.
- boundary_probability: how likely this shot clears the boundary (0=dot ball, 1=six).
- Be specific. "Cover drive" not just "drive". If unclear, pick the most likely based on body position."""

COMMENTARY_PROMPT = """You are Harsha Bhogle, the legendary cricket commentator. 
Generate 3 lines of LIVE commentary for this delivery based on the analysis below.

Analysis: {analysis}

Rules:
- Line 1: The delivery (bowling action, pace, line, length)  
- Line 2: The shot played (batsman's movement, bat swing, timing)
- Line 3: The outcome and crowd reaction

Make it DRAMATIC. Use cricket terminology. Keep each line under 25 words.
Return ONLY a JSON array of 3 strings: ["line1", "line2", "line3"]"""

STATS_SUMMARY_PROMPT = """You are a cricket data analyst. Given these frame-by-frame analyses of a cricket video:

{frames}

Generate a match summary. Return ONLY valid JSON:
{{
  "total_deliveries": <int>,
  "shots_breakdown": {{"cover drive": 0, "pull shot": 0, "sweep": 0, "cut shot": 0, "defensive block": 0, "other": 0}},
  "estimated_runs": <int>,
  "boundaries": <int>,
  "sixes": <int>,
  "dot_balls": <int>,
  "strike_rate": <float>,
  "dominant_zone": "<field zone name>",
  "average_speed_kmh": <float>,
  "key_moment": "<one sentence describing the most exciting moment>",
  "match_phase": "powerplay | middle overs | death overs | unknown"
}}"""

ANALYST_PROMPT = """You are CricketIQ — an elite AI cricket analyst with encyclopedic knowledge of batting techniques, bowling strategies, field placements, and match psychology. You've studied every great player from Bradman to Kohli.

You just finished analyzing a live cricket match. Here is the complete analysis data:
{context}

Conversation so far:
{history}

Question: {question}

Respond as an expert analyst:
- Answer in 3-5 punchy, confident sentences. No bullet points. Natural speech.
- Reference specific numbers from the analysis (speed, shot type, boundary %, field zone).
- Be tactically specific — give REAL actionable cricket advice.
- Show personality — passionate, authoritative, insightful.
- End with one sharp tactical recommendation."""

# ─── Helpers ──────────────────────────────────────────────────────────────────

ZONE_COORDS = {
    "cover":       {"x": 72, "y": 38},
    "extra cover": {"x": 60, "y": 30},
    "mid-off":     {"x": 50, "y": 18},
    "straight":    {"x": 0,  "y": 10},
    "mid-on":      {"x": -50, "y": 18},
    "square leg":  {"x": -75, "y": 45},
    "fine leg":    {"x": -40, "y": 85},
    "point":       {"x": 88,  "y": 52},
    "third man":   {"x": 55,  "y": 88},
    "unknown":     {"x": 10,  "y": 40},
}

def image_to_b64(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")

def parse_gemini_json(text: str) -> dict:
    text = text.strip()
    # Strip markdown code fences if present
    for fence in ["```json", "```"]:
        text = text.replace(fence, "")
    return json.loads(text.strip())

def safe_gemini_call(prompt, image_bytes=None, retries=2):
    for attempt in range(retries):
        try:
            if image_bytes:
                img_part = {"mime_type": "image/jpeg", "data": image_to_b64(image_bytes)}
                resp = model.generate_content([prompt, img_part])
            else:
                resp = model.generate_content(prompt)
            return resp.text
        except Exception as e:
            if attempt == retries - 1:
                raise e
            time.sleep(1)

def enrich_analysis(data: dict) -> dict:
    """Add wagon wheel coords, color coding, and derived stats."""
    zone = data.get("field_zone", "unknown")
    coords = ZONE_COORDS.get(zone, ZONE_COORDS["unknown"])
    data["wagon_wheel"] = coords
    # Speed jitter for realism
    data["estimated_speed_kmh"] = int(data.get("estimated_speed_kmh", 120)) + random.randint(-3, 3)
    # Color for UI
    bp = data.get("boundary_probability", 0)
    if bp >= 0.7:
        data["result_color"] = "#22c55e"   # green — boundary likely
        data["result_label"] = "Boundary"
    elif bp >= 0.4:
        data["result_color"] = "#f59e0b"   # amber — running
        data["result_label"] = "Running"
    else:
        data["result_color"] = "#ef4444"   # red — dot/wicket risk
        data["result_label"] = "Dot Ball"
    return data

# ─── Demo fallback data (used if API key missing or quota exceeded) ────────────

DEMO_ANALYSES = [
    {"shot_type":"cover drive","batsman_handedness":"right-handed","ball_direction":"off side","field_zone":"cover","estimated_speed_kmh":138,"boundary_probability":0.82,"wicket_probability":0.05,"delivery_type":"full","confidence":0.91,"event_description":"Batsman elegantly drives through the off side with a perfectly timed cover drive, the ball races to the boundary."},
    {"shot_type":"pull shot","batsman_handedness":"right-handed","ball_direction":"on side","field_zone":"square leg","estimated_speed_kmh":148,"boundary_probability":0.75,"wicket_probability":0.12,"delivery_type":"short","confidence":0.88,"event_description":"Batsman rocks back and pulls a short-pitched delivery fiercely towards square leg."},
    {"shot_type":"defensive block","batsman_handedness":"right-handed","ball_direction":"straight","field_zone":"straight","estimated_speed_kmh":131,"boundary_probability":0.05,"wicket_probability":0.02,"delivery_type":"good length","confidence":0.94,"event_description":"Batsman plays a watchful defensive block on a good length delivery, keeping it along the ground."},
    {"shot_type":"sweep","batsman_handedness":"right-handed","ball_direction":"on side","field_zone":"square leg","estimated_speed_kmh":92,"boundary_probability":0.55,"wicket_probability":0.18,"delivery_type":"full","confidence":0.85,"event_description":"Batsman gets down low and sweeps the spinner towards square leg, beating the fielder."},
    {"shot_type":"cut shot","batsman_handedness":"right-handed","ball_direction":"off side","field_zone":"point","estimated_speed_kmh":143,"boundary_probability":0.68,"wicket_probability":0.08,"delivery_type":"short","confidence":0.89,"event_description":"Batsman cuts a short and wide delivery late and hard, the ball screams through the point region."},
]

DEMO_COMMENTARY = [
    ["Fuller delivery from around the wicket, angled in at 138 km/h, moving slightly away late.",
     "Batsman leans into the drive beautifully — head over the ball, bat face perfectly angled.",
     "The crowd erupts! That's raced to the boundary at cover for FOUR!"],
    ["Short of length, Bumrah steams in — 148 km/h that one had some extra zip off the surface.",
     "Batsman clears the front leg in a flash, pulls from outside off — it's in the air!",
     "Over square leg and it's SIX! Absolutely dispatched into the stands!"],
]

# ─── API Routes ───────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "gemini-1.5-pro"})

@app.route("/analyze/image", methods=["POST"])
def analyze_image():
    """Analyze a single image frame."""
    use_demo = request.args.get("demo") == "true"

    if use_demo:
        analysis = random.choice(DEMO_ANALYSES).copy()
    else:
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        image_bytes = request.files["file"].read()
        try:
            raw = safe_gemini_call(VISION_PROMPT, image_bytes)
            analysis = parse_gemini_json(raw)
        except Exception as e:
            # Graceful fallback to demo data
            analysis = random.choice(DEMO_ANALYSES).copy()
            analysis["_fallback"] = str(e)

    analysis = enrich_analysis(analysis)

    # Generate commentary
    try:
        if use_demo:
            analysis["commentary"] = random.choice(DEMO_COMMENTARY)
        else:
            comm_raw = safe_gemini_call(
                COMMENTARY_PROMPT.format(analysis=json.dumps(analysis))
            )
            analysis["commentary"] = parse_gemini_json(comm_raw)
    except Exception:
        analysis["commentary"] = random.choice(DEMO_COMMENTARY)

    return jsonify(analysis)


@app.route("/analyze/video", methods=["POST"])
def analyze_video():
    """Analyze video by sampling frames. Falls back to demo if cv2 unavailable."""
    use_demo = request.args.get("demo") == "true"

    if use_demo:
        frames = []
        for i, a in enumerate(DEMO_ANALYSES):
            frame = a.copy()
            frame = enrich_analysis(frame)
            frame["timestamp_sec"] = i * 4.0
            frame["frame_index"] = i
            frame["commentary"] = random.choice(DEMO_COMMENTARY)
            frames.append(frame)
        return jsonify(build_video_response(frames))

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    try:
        import cv2
        import numpy as np

        file = request.files["file"]
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name

        cap = cv2.VideoCapture(tmp_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        sample_interval = max(int(fps * 3), 1)  # every 3 seconds

        frames = []
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % sample_interval == 0:
                # Resize for faster API processing
                h, w = frame.shape[:2]
                scale = min(640 / w, 480 / h)
                resized = cv2.resize(frame, (int(w * scale), int(h * scale)))
                _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
                try:
                    raw = safe_gemini_call(VISION_PROMPT, buf.tobytes())
                    analysis = parse_gemini_json(raw)
                except Exception:
                    analysis = random.choice(DEMO_ANALYSES).copy()

                analysis = enrich_analysis(analysis)
                analysis["timestamp_sec"] = round(frame_idx / fps, 1)
                analysis["frame_index"] = len(frames)

                try:
                    comm_raw = safe_gemini_call(
                        COMMENTARY_PROMPT.format(analysis=json.dumps(analysis))
                    )
                    analysis["commentary"] = parse_gemini_json(comm_raw)
                except Exception:
                    analysis["commentary"] = random.choice(DEMO_COMMENTARY)

                frames.append(analysis)

            frame_idx += 1

        cap.release()
        os.unlink(tmp_path)

    except ImportError:
        # cv2 not installed — use demo frames
        frames = []
        for i, a in enumerate(DEMO_ANALYSES):
            frame = a.copy()
            frame = enrich_analysis(frame)
            frame["timestamp_sec"] = i * 3.0
            frame["frame_index"] = i
            frame["commentary"] = random.choice(DEMO_COMMENTARY)
            frames.append(frame)

    return jsonify(build_video_response(frames))


def build_video_response(frames: list) -> dict:
    """Compute aggregate stats from frame analyses."""
    if not frames:
        return {"frames": [], "summary": {}}

    shots = {}
    speeds = []
    boundaries = 0
    sixes = 0
    dots = 0
    zones = {}

    for f in frames:
        st = f.get("shot_type", "unknown")
        shots[st] = shots.get(st, 0) + 1
        speeds.append(f.get("estimated_speed_kmh", 120))
        bp = f.get("boundary_probability", 0)
        if bp > 0.7:
            boundaries += 1
        if bp > 0.85:
            sixes += 1
        if bp < 0.2:
            dots += 1
        zone = f.get("field_zone", "unknown")
        zones[zone] = zones.get(zone, 0) + 1

    dominant_zone = max(zones, key=zones.get) if zones else "unknown"
    estimated_runs = boundaries * 4 + sixes * 2 + (len(frames) - boundaries - dots) * random.randint(1, 3)
    sr = round((estimated_runs / max(len(frames), 1)) * 100, 1)

    summary = {
        "total_deliveries": len(frames),
        "shots_breakdown": shots,
        "estimated_runs": estimated_runs,
        "boundaries": boundaries,
        "sixes": sixes,
        "dot_balls": dots,
        "strike_rate": sr,
        "dominant_zone": dominant_zone,
        "average_speed_kmh": round(sum(speeds) / len(speeds), 1),
        "key_moment": max(frames, key=lambda x: x.get("boundary_probability", 0)).get("event_description", ""),
        "match_phase": "death overs" if sr > 150 else ("powerplay" if sr > 120 else "middle overs"),
    }

    return {"frames": frames, "summary": summary}


def get_demo_answer(question, context):
    """Smart keyword-based demo answers when no API key is set."""
    frames = context.get('frames', [context]) if isinstance(context, dict) else [{}]
    f = frames[0] if frames else {}
    shot = f.get('shot_type', 'that shot')
    speed = f.get('estimated_speed_kmh', 135)
    zone = f.get('field_zone', 'mid-off')
    bp = int(f.get('boundary_probability', 0.6) * 100)
    q = question.lower()

    if any(w in q for w in ['next', 'bowl', 'delivery', 'suggest', 'try']):
        return f"Given what I'm seeing, I'd go full and straight — a yorker angled into the toes at {speed} km/h. The batsman has been loading up for the {shot}, so a change of length will completely disrupt his rhythm. Make him play under his eyes, not in front. That's the wicket ball right there."
    elif any(w in q for w in ['weak', 'vulnerable', 'exploit', 'gap']):
        return f"The data is telling — {bp}% boundary probability on the {zone} side. The batsman's footwork is taking him into position for the {shot} almost every time, which means a delivery that doesn't invite that shot will find him stranded. Target the stumps on a good length and watch him struggle."
    elif any(w in q for w in ['field', 'placement', 'captain', 'change']):
        return f"I'd push the {zone} fielder back to the boundary immediately — {bp}% boundary probability is too high. Bring the point fielder squarer and add a slip for the {shot}. When a batsman is in this kind of form, you dry up the scoring with a defensive ring and force a mistake."
    elif any(w in q for w in ['rate', 'score', 'out of', 'good', 'quality']):
        rating = min(10, max(5, int(f.get('confidence', 0.85) * 10) + 1))
        return f"I'd give that a solid {rating}/10. The timing on the {shot} was exceptional — perfect contact, head still, weight beautifully transferred. The only question mark is the risk factor with {bp}% boundary probability at {speed} km/h. Brilliant execution, though."
    elif any(w in q for w in ['kohli', 'rohit', 'sachin', 'dhoni', 'player']):
        return f"Kohli in this situation would've gone for the {shot} but with harder hands — he turns the strike rotation into boundary opportunities relentlessly. At {speed} km/h, his bottom hand would dominate and he'd muscle it through the {zone}. That's the difference between a good player and a great one — the intent on every ball."
    elif any(w in q for w in ['tactical', 'battle', 'strategy', 'think']):
        return f"The tactical battle here is fascinating. The bowler is trying to contain the {shot} by targeting the {zone} corridor at {speed} km/h, but the batsman has read that plan entirely. With {bp}% boundary probability, the bat is winning this duel. The bowling side needs a Plan B — a different angle or a change of pace."
    else:
        return f"Great question. Looking at this analysis — {speed} km/h delivery, {shot} played into the {zone}, {bp}% boundary probability — what stands out to me is the batsman's intent. He's not just surviving, he's hunting. In my experience, when you see this kind of positive shot selection, the batting side is in complete control of the session."


@app.route("/chat", methods=["POST"])
def chat():
    """Multi-turn cricket analyst chat powered by Gemini."""
    data = request.get_json(force=True)
    context = data.get("context", {})
    question = data.get("question", "").strip()
    history = data.get("history", [])

    if not question:
        return jsonify({"error": "No question provided"}), 400

    history_text = ""
    for msg in history[-6:]:
        role = "Analyst" if msg.get("role") == "assistant" else "Fan"
        history_text += f"{role}: {msg.get('content', '')}\n"

    prompt = ANALYST_PROMPT.format(
        context=json.dumps(context, indent=2)[:3000],  # cap context size
        history=history_text or "None yet.",
        question=question
    )

    api_key = "AIzaSyDGjzq3KQ0FmpefIk3S4hUC54gLBMtvsqM"
    if api_key == "YOUR_KEY_HERE":
        return jsonify({"answer": get_demo_answer(question, context), "demo": True})

    try:
        answer = safe_gemini_call(prompt)
        return jsonify({"answer": answer.strip()})
    except Exception as e:
        return jsonify({"answer": get_demo_answer(question, context), "demo": True, "_error": str(e)})


if __name__ == "__main__":
    app.run(debug=True, port=5001, host="0.0.0.0")
