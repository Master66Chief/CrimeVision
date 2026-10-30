"""
ClassMind AI - Robust Temporal Attendance State Machine.
Evaluates continuous presence across a sliding observation window, distinguishes
raw detections, optional biometric identity matching, and attendance verification,
and gracefully handles temporary occlusions, late arrivals, and early departures.
"""

from collections import deque
from datetime import datetime
from typing import Dict, List, Optional, Set, Any
from config import config
from src.database import log_attendance_record, get_session_attendance


class StudentPresenceState:
    def __init__(self, student_id: str, name: str, roll_no: str, section: str = "Section A"):
        self.student_id = student_id
        self.name = name
        self.roll_no = roll_no
        self.section = section
        
        # Temporal observations
        self.first_detected: Optional[datetime] = None
        self.last_detected: Optional[datetime] = None
        self.observed_presence_seconds: float = 0.0
        self.status: str = "Unverified"  # 'Present', 'Partial', 'Absent', 'Unverified'
        
        # Sliding observation buffer: deque of (epoch_timestamp, detected_bool)
        self.sliding_window: deque = deque()
        
        # Occlusion tolerance & grace period tracking
        self.consecutive_absent_seconds: float = 0.0
        self.last_seen_epoch: float = 0.0
        
        # Arrival & departure flags
        self.is_late: bool = False
        self.is_early_departure: bool = False
        self.confidence: float = 0.85
        self.verification_reason: str = "Awaiting observations"
        self.manual_override: bool = False

    def record_observation(
        self,
        is_observed: bool,
        current_epoch: float,
        dt: float,
        session_elapsed_sec: float,
        window_duration: float = 15.0,
        late_threshold_sec: float = 300.0  # 5 minutes into session counts as late
    ):
        """Updates the temporal sliding window with the current frame observation."""
        if self.manual_override:
            # Respect instructor manual corrections
            return

        now = datetime.now()

        if is_observed:
            if self.first_detected is None:
                self.first_detected = now
                if session_elapsed_sec > late_threshold_sec:
                    self.is_late = True
            self.last_detected = now
            self.last_seen_epoch = current_epoch
            self.observed_presence_seconds += dt
            self.consecutive_absent_seconds = 0.0
        else:
            if self.first_detected is not None:
                self.consecutive_absent_seconds += dt

        # Append to sliding window
        self.sliding_window.append((current_epoch, is_observed))

        # Evict records older than window_duration
        cutoff = current_epoch - window_duration
        while self.sliding_window and self.sliding_window[0][0] < cutoff:
            self.sliding_window.popleft()

    @property
    def window_presence_ratio(self) -> float:
        """Computes observed ratio inside active sliding window."""
        if not self.sliding_window:
            return 0.0
        valid_hits = sum(1 for _, hit in self.sliding_window if hit)
        return float(valid_hits / len(self.sliding_window))


class SustainedPresenceEngine:
    """
    Temporal attendance engine tracking multi-target presence states.
    Prevents false positives from passing pedestrians by requiring sustained verification.
    """
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.states: Dict[str, StudentPresenceState] = {}
        self.session_start_epoch: float = 0.0
        self.window_duration: float = config.attendance.window_duration_seconds
        self.presence_ratio_threshold: float = config.attendance.sustained_presence_ratio
        self.min_sustained_seconds: float = 8.0  # minimum cumulative seconds to qualify for Present
        self.occlusion_grace_period_sec: float = 6.0  # temporary occlusion before state downgrade
        
        self._load_roster()

    def load_roster(self):
        """Public alias to reload enrolled roster from SQLite."""
        self._load_roster()

    def _load_roster(self):
        """Loads enrolled roster from SQLite."""
        roster = get_session_attendance(self.session_id)
        new_states = {}
        for r in roster:
            s_id = r["student_id"]
            state = StudentPresenceState(
                student_id=s_id,
                name=r["name"],
                roll_no=r["roll_no"],
                section=r.get("section", "Section A") if hasattr(r, "get") else r["section"]
            )
            state.status = r["status"] if "status" in r and r["status"] else "Unverified"
            state.observed_presence_seconds = r["sustained_seconds"] if "sustained_seconds" in r and r["sustained_seconds"] else 0.0
            state.confidence = r["confidence"] if "confidence" in r and r["confidence"] else 0.85
            state.verification_reason = r["verification_reason"] if "verification_reason" in r and r["verification_reason"] else "Roster Enrolled"
            if "manual_correction" in r and r["manual_correction"]:
                state.manual_override = True
            new_states[s_id] = state
        self.states = new_states

    def process_frame(
        self,
        detected_student_ids: List[str],
        current_epoch: float,
        dt: float,
        is_paused: bool = False
    ):
        """
        Advances the attendance state machine for all enrolled students.
        """
        if is_paused:
            return

        if self.session_start_epoch == 0.0:
            self.session_start_epoch = current_epoch

        session_elapsed = current_epoch - self.session_start_epoch
        detected_set = set(detected_student_ids)

        for s_id, state in list(self.states.items()):
            is_present = s_id in detected_set
            state.record_observation(
                is_observed=is_present,
                current_epoch=current_epoch,
                dt=dt,
                session_elapsed_sec=session_elapsed,
                window_duration=self.window_duration
            )

            if state.manual_override:
                continue

            # Evaluate state transitions
            ratio = state.window_presence_ratio
            cumulative = state.observed_presence_seconds

            if ratio >= self.presence_ratio_threshold and cumulative >= self.min_sustained_seconds:
                state.status = "Present"
                state.confidence = min(0.98, 0.75 + (ratio * 0.23))
                state.verification_reason = f"Verified sustained presence ({int(ratio*100)}% in {int(self.window_duration)}s window)"
            elif cumulative >= 3.0:
                # Detected intermittently or during transition
                state.status = "Partial"
                state.confidence = 0.70
                state.verification_reason = f"Partial presence observed ({round(cumulative, 1)}s cumulative)"
            elif state.first_detected is not None:
                state.status = "Unverified"
                state.confidence = 0.50
                state.verification_reason = "Transient glance or passerby (<3s observed)"
            else:
                state.status = "Absent"
                state.confidence = 0.90
                state.verification_reason = "No visual detection registered"

            # Check early departure (if previously marked present but absent for > 60s)
            if state.status == "Present" and state.consecutive_absent_seconds > 60.0:
                state.is_early_departure = True
                state.status = "Partial"
                state.verification_reason = f"Early departure flagged (absent for {int(state.consecutive_absent_seconds)}s)"

            # Persist to database if student has at least one detection or is absent
            if state.first_detected is not None:
                log_attendance_record(
                    session_id=self.session_id,
                    student_id=state.student_id,
                    first_detected=state.first_detected.strftime("%Y-%m-%d %H:%M:%S"),
                    last_detected=state.last_detected.strftime("%Y-%m-%d %H:%M:%S") if state.last_detected else "",
                    sustained_seconds=round(state.observed_presence_seconds, 1),
                    presence_ratio=round(ratio, 2),
                    status=state.status,
                    confidence=round(state.confidence, 2),
                    verification_reason=state.verification_reason,
                    is_late=state.is_late,
                    is_early_departure=state.is_early_departure
                )

    def get_summary(self) -> Dict[str, Any]:
        """Provides an aggregated summary for API and dashboard presentation."""
        states_list = list(self.states.values())
        total = len(states_list)
        present = sum(1 for s in states_list if s.status == "Present")
        partial = sum(1 for s in states_list if s.status == "Partial")
        unverified = sum(1 for s in states_list if s.status == "Unverified")
        absent = total - present - partial - unverified

        records = []
        for s in states_list:
            records.append({
                "student_id": s.student_id,
                "roll_no": s.roll_no,
                "name": s.name,
                "section": s.section,
                "status": s.status,
                "sustained_seconds": round(s.observed_presence_seconds, 1),
                "presence_ratio": round(s.window_presence_ratio * 100, 1),
                "confidence": round(s.confidence, 2),
                "verification_reason": s.verification_reason,
                "is_late": s.is_late,
                "is_early_departure": s.is_early_departure,
                "first_detected": s.first_detected.strftime("%H:%M:%S") if s.first_detected else "-",
                "last_detected": s.last_detected.strftime("%H:%M:%S") if s.last_detected else "-",
                "manual_correction": s.manual_override
            })

        return {
            "session_id": self.session_id,
            "total_enrolled": total,
            "present_count": present,
            "partial_count": partial,
            "absent_count": absent,
            "unverified_count": unverified,
            "attendance_rate": round((present / max(1, total)) * 100, 1),
            "records": records
        }
