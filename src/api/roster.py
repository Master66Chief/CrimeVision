"""
ClassMind AI - Student Roster Management API Router.
"""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends
from src.database import get_db_connection
from src.schemas import StudentSchema, StudentUpdateRequest
from src.dependencies import get_session_manager
from src.services.session_manager import SessionManager

router = APIRouter(prefix="/api/roster", tags=["Student Roster Management"])


@router.get("", response_model=List[StudentSchema])
async def get_all_students():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT student_id, roll_no, name, section, face_encoding FROM students ORDER BY roll_no ASC")
    rows = cursor.fetchall()
    conn.close()

    return [
        StudentSchema(
            student_id=r["student_id"],
            roll_no=r["roll_no"],
            name=r["name"],
            section=r["section"] if r["section"] else "Section A",
            has_biometric_enrolled=bool(r["face_encoding"])
        )
        for r in rows
    ]


@router.post("", response_model=StudentSchema)
async def add_student(student: StudentSchema, mgr: SessionManager = Depends(get_session_manager)):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO students (student_id, roll_no, name, section)
        VALUES (?, ?, ?, ?)
        """, (student.student_id, student.roll_no, student.name, student.section))

        # Also add unverified attendance record to active session
        if mgr.active_session_id:
            cursor.execute("""
            INSERT OR IGNORE INTO attendance_records (session_id, student_id, status, verification_reason)
            VALUES (?, ?, 'Unverified', 'Newly Enrolled Student - Awaiting Observation')
            """, (mgr.active_session_id, student.student_id))

        conn.commit()
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Failed to add student: {str(e)}")
    conn.close()

    if mgr.pipeline and mgr.pipeline.attendance_engine:
        mgr.pipeline.attendance_engine.load_roster()

    return student


@router.put("/{student_id}", response_model=StudentSchema)
async def update_student(
    student_id: str,
    payload: StudentUpdateRequest,
    mgr: SessionManager = Depends(get_session_manager)
):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT student_id, roll_no, name, section, face_encoding FROM students WHERE student_id = ?", (student_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Student not found")

    new_roll = payload.roll_no if payload.roll_no is not None else row["roll_no"]
    new_name = payload.name if payload.name is not None else row["name"]
    new_sec = payload.section if payload.section is not None else row["section"]

    try:
        cursor.execute("""
        UPDATE students SET roll_no = ?, name = ?, section = ? WHERE student_id = ?
        """, (new_roll, new_name, new_sec, student_id))
        conn.commit()
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Failed to update student: {str(e)}")
    conn.close()

    if mgr.pipeline and mgr.pipeline.attendance_engine:
        mgr.pipeline.attendance_engine.load_roster()

    return StudentSchema(
        student_id=student_id,
        roll_no=new_roll,
        name=new_name,
        section=new_sec,
        has_biometric_enrolled=bool(row["face_encoding"])
    )


@router.delete("/{student_id}")
async def delete_student(student_id: str, mgr: SessionManager = Depends(get_session_manager)):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT student_id FROM students WHERE student_id = ?", (student_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Student not found")

    cursor.execute("DELETE FROM students WHERE student_id = ?", (student_id,))
    conn.commit()
    conn.close()

    if mgr.pipeline and mgr.pipeline.attendance_engine:
        if student_id in mgr.pipeline.attendance_engine.states:
            del mgr.pipeline.attendance_engine.states[student_id]
        mgr.pipeline.attendance_engine.load_roster()

    return {"status": "success", "deleted_student_id": student_id}
