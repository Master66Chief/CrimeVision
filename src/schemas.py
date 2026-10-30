"""
ClassMind AI - Pydantic Request & Response Schemas.
Validates all REST and WebSocket payloads across the platform.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime


# ==========================================
# System & Health Schemas
# ==========================================
class HardwareStatus(BaseModel):
    camera_available: bool = False
    camera_device: str = "Default Camera"
    camera_error: Optional[str] = None
    microphone_available: bool = False
    microphone_device: str = "Default Microphone"
    simulated_mode: bool = False
    processing_fps: float = 0.0
    inference_latency_ms: float = 0.0


class SystemHealthResponse(BaseModel):
    status: str = "healthy"
    app_name: str = "ClassMind AI"
    version: str = "2.0.0"
    offline_mode: bool = True
    hardware: HardwareStatus
    active_session_id: Optional[str] = None


# ==========================================
# Session Management Schemas
# ==========================================
class SessionCreateRequest(BaseModel):
    title: str = Field(..., min_length=2, max_length=150, description="Session title")
    section: Optional[str] = Field(default="Section A", description="Class section or room")
    instructor_name: Optional[str] = Field(default="Instructor", description="Instructor name")
    total_enrolled: Optional[int] = Field(default=6, ge=1, le=500)


class SessionResponse(BaseModel):
    session_id: str
    title: str
    section: str
    instructor_name: str
    start_time: str
    end_time: Optional[str] = None
    is_active: bool
    is_paused: bool = False
    total_enrolled: int
    total_present: int
    avg_engagement: float


class SessionActionRequest(BaseModel):
    action: str = Field(..., description="'start', 'pause', 'resume', or 'stop'")


# ==========================================
# Roster & Attendance Schemas
# ==========================================
class StudentSchema(BaseModel):
    student_id: str
    roll_no: str
    name: str
    section: str = "Section A"
    has_biometric_enrolled: bool = False


class StudentUpdateRequest(BaseModel):
    roll_no: Optional[str] = None
    name: Optional[str] = None
    section: Optional[str] = None


class AttendanceRecordSchema(BaseModel):
    student_id: str
    roll_no: str
    name: str
    section: str
    status: str  # 'Present', 'Partial', 'Absent', 'Unverified'
    sustained_seconds: float
    presence_ratio: float
    confidence: float
    verification_reason: str
    first_detected: Optional[str] = None
    last_detected: Optional[str] = None
    is_late: bool = False
    is_early_departure: bool = False
    manual_correction: bool = False
    correction_reason: Optional[str] = None


class AttendanceSummaryResponse(BaseModel):
    session_id: str
    total_enrolled: int
    present_count: int
    partial_count: int
    absent_count: int
    unverified_count: int
    attendance_rate: float
    records: List[AttendanceRecordSchema]


class ManualAttendanceCorrectionRequest(BaseModel):
    student_id: str
    new_status: str = Field(..., description="'Present', 'Partial', 'Absent', or 'Unverified'")
    reason: str = Field(..., min_length=3, max_length=255, description="Reason for instructor override")
    instructor_id: Optional[str] = "Instructor"


class AttendanceAuditLogSchema(BaseModel):
    id: int
    session_id: str
    student_id: str
    previous_status: str
    new_status: str
    changed_by: str
    reason: str
    timestamp: str


# ==========================================
# Engagement & Analytics Schemas
# ==========================================
class ParticipantHUD(BaseModel):
    track_id: int
    student_id: Optional[str] = None
    display_name: str
    state: str  # 'Attentive', 'Looking Down / Notes', 'Turned Away'
    attentiveness_score: float
    motion_score: float
    is_inactive: bool
    inactivity_seconds: float
    identity_matched: bool = False
    attendance_verified: bool = False


class TelemetryPoint(BaseModel):
    timestamp: float
    overall_engagement: float
    head_pose_score: float
    movement_score: float
    audio_score: float
    active_count: int
    disengaged_count: int
    total_detected: int
    trend: str
    is_speech: bool
    rms_energy: float
    sensor_coverage: float
    active_sensors: List[str]
    confidence: float


class AnalyticsSummaryResponse(BaseModel):
    session_id: str
    duration_seconds: float
    current_engagement: float
    trend: str
    breakdown: Dict[str, float]
    sensor_health: Dict[str, bool]
    timeseries: List[TelemetryPoint]


# ==========================================
# Teaching Copilot Recommendations
# ==========================================
class RecommendationSchema(BaseModel):
    id: int
    alert_type: str
    priority: str  # 'info', 'warning', 'urgent'
    title: str
    suggestion: str
    rationale: str
    instructional_purpose: str
    triggering_signal: str
    timestamp: str
    is_dismissed: bool = False
    is_helpful: Optional[bool] = None


class RecommendationFeedbackRequest(BaseModel):
    is_dismissed: Optional[bool] = None
    is_helpful: Optional[bool] = None


# ==========================================
# Settings & Privacy Schemas
# ==========================================
class SettingsSchema(BaseModel):
    # Simulation & Privacy
    use_simulation: bool = False
    anonymize_faces: bool = True
    biometric_matching_enabled: bool = False
    data_retention_days: int = 30
    
    # Attendance Engine
    window_duration_seconds: float = 15.0
    sustained_presence_ratio: float = 0.60
    min_face_size: int = 40
    
    # Engagement Weights (Normalized)
    weight_head_pose: float = 0.45
    weight_movement: float = 0.25
    weight_audio_activity: float = 0.30
    
    # Recommendation Agent
    attention_drop_threshold: float = 45.0
    sustained_drop_duration_sec: float = 12.0
    cooldown_seconds: float = 20.0
    
    # Hardware
    selected_camera_index: int = 0
    selected_mic_index: int = 0
