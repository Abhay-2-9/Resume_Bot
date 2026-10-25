from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from pathlib import Path
from pypdf import PdfReader
from groq import Groq
from dotenv import load_dotenv
from pydantic import BaseModel, Field, ConfigDict
import os, json
from fastapi.responses import StreamingResponse, PlainTextResponse
from typing import Literal

load_dotenv()  # Load environment variables from .env file
client = Groq(api_key=os.getenv("GROQ_API_KEY")) # Initialize Groq client with API key from environment variable
model = "openai/gpt-oss-120b"  # Specify the model to use

app = FastAPI()  # Create the server app

# CORS: which websites may call this API from a browser
# or which websites are allowed to make requests to this API from a browser
DEFAULT_ORIGINS = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:5500,http://127.0.0.1:5500"
)
ALLOWED_ORIGINS = [
    o.strip().rstrip("/")
    for o in os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    error_type = exc.errors()[0]["type"]
    if error_type == "string_too_short":
        message = "Please enter some text."
    elif error_type == "string_too_long":
        message = "Your question is too long. Please keep it under 500 characters."
    elif error_type == "missing":
        message = 'Please send a JSON body like {"question": "your question"}.'
    else:
        message = "Invalid request. Please check your input and try again."
    return PlainTextResponse(message, status_code=422)

class Experience(BaseModel):
    company: str | None = None
    role: str | None = None
    duration: str | None = None
    description: str | None = None
    skills_used: list[str] = []

class Resume(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None

    total_experience_years: float | None = None

    skills: list[str] = []
    experiences: list[Experience] = []
    education: list[str] = []
    projects: list[str] = []
    certifications: list[str] = []

resume_schema = Resume.model_json_schema()

class Message(BaseModel):
    role: Literal["user", "assistant"]          # blocks fake "system" messages
    content: str = Field(max_length=4000)

class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    question : str = Field(min_length=1, max_length=500) # reject empty / huge questions (422 error)
    history: list[Message] = Field(default=[], max_length=10)

BASE_DIR = Path(__file__).parent
with open(BASE_DIR / "other_questions.json", encoding="utf-8") as f:
    other_qa = json.load(f)   # list of {"question": ..., "answer": ...}

def ask_candidate(question: str, resume : Resume, history: list[Message]):
    system_prompt = f"""
    You are Abhay Tiwary's resume bot. If asked who you are, say you are Abhay's bot.
    If asked about Abhay's skills or experience, use the information from the attached json files.
    If asked about other questions, use the information from the attached json files. If the question is not in the JSON, say "I don't have enough information to answer that question."
    For questions about Abhay's background, answer in a friendly first-person style based on the facts below.
    If something isn't covered, say you don't have that information.
    Don't search for the exact question in the JSON, but answer based on the information in the JSON and the resume.
    If you don't have enough information to answer a question, say "I don't have enough information to answer that question."
    Always be honest and transparent in your responses.
    Always answer in a professional manner, as if you are Abhay's representative.
    Be polite.

    RESUME INFORMATION:
    {resume.model_dump_json(indent=2, exclude ={"email", "phone"}, ensure_ascii=False)}
    Other Questions and Answers:
    {json.dumps(other_qa, indent=2, ensure_ascii=False)}

    Rules :
    1. Answer only using this information.
    2. Never hallucinate or make up information.
    3. If the information is not available, say "I don't have enough information to answer that question."
    4. Be professional.
    5. Answer as if HR is interviewing this candidate.
    6. Don't reveal my phone number or email address in the output.
    7. If someone asks about how to contact me, then give me Linkedin profile link that is "https://www.linkedin.com/in/-abhay-tiwary-" instead of email or phone number.
    """
    messages = [{"role": "system", "content": system_prompt}]
    messages += [m.model_dump() for m in history[-10:]]
    messages.append({"role": "user", "content": question})
    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True
        )
        for chunk in response:
            if not chunk.choices:                 # some chunks can have no choices
                continue
            content = chunk.choices[0].delta.content
            if content:
                yield content                     # send this piece out, then continue
    except Exception as e:
        # Groq down, rate limit hit, network problem... the user gets a message instead of a dead stream
        print(f"Groq error: {e}")
        yield "\n\nSorry, I'm having trouble answering right now. Please try again in a moment."

def parse_resume(resume_text):
    system_prompt = f"""
    You are an expert resume parser.

    Extract information from the resume based on its meaning,
    not only based on exact section headings.

    Different resumes may use different headings.

    For example:
    - Experience
    - Professional Experience
    - Work History
    - Employment
    - Internships

    These may all contain relevant experience.

    Skills may also appear in the skills section, work experience,
    internships or projects.

    Return ONLY valid JSON matching this schema:

    {resume_schema}

    Important rules:

    1. Do not invent information.
    2. If a value is not available, return null.
    3. If a list has no information, return an empty list.
    4. Include internships inside experiences.
    5. Extract skills mentioned across the entire resume.
    """
    user_prompt = f"""
    Parse the following resume:

    {resume_text}
    """
    message_system={
        "role" : "system",
        "content" : system_prompt
    }
    message_user={
        "role" : "user",
        "content" : user_prompt
    }
    messages=[message_system, message_user]
    response_format={
        "type": "json_object"
    }
    response=client.chat.completions.create(model=model, messages=messages, response_format=response_format)
    raw_output = response.choices[0].message.content
    data = json.loads(raw_output)
    resume = Resume(**data)
    return resume

# pdf extraction function
def read_pdf(file_path: Path):
    reader = PdfReader(file_path)      # open the PDF
    text = ""                          # empty string to collect text
    for page in reader.pages:          # go through every page
        page_text = page.extract_text()    # pull the text out of this page
        if page_text:                      # only if the page actually had text
            text += page_text + "\n"       # add it, plus a newline between pages
    return text                        # give back the combined text

RESUME_PDF = BASE_DIR / "resume.pdf"
RESUME_JSON = BASE_DIR / "resume.json"   # cache of the parsed resume
 
def load_resume() -> Resume:
    # 1. cache exists -> load it, no LLM call
    if RESUME_JSON.exists():
        print("Loaded resume from resume.json")
        return Resume.model_validate_json(RESUME_JSON.read_text(encoding="utf-8"))
 
    # 2. no cache -> parse the PDF with the LLM, then save the result
    print("resume.json not found, parsing PDF with LLM...")
    parsed = parse_resume(read_pdf(RESUME_PDF))
    try:
        RESUME_JSON.write_text(parsed.model_dump_json(indent=2), encoding="utf-8")
    except OSError:
        print("Could not save resume.json (read-only disk?), continuing without cache")
    return parsed
 
resume = load_resume()   # runs once, at startup (delete resume.json after editing the PDF)

@app.get("/hiremeAI") # Route: when a GET request hits "/hiremeAI", run home() and return its dict as JSON
def home():
    # resume_text = read_pdf(Path("resume.pdf"))  # read the resume.pdf file
    # resume = parse_resume(resume_text)
    # print(resume.model_dump_json(indent=2))  # print the parsed resume as JSON to the console (for debugging)
    return {
        "message" : "hiremeAI is running !"
    }

@app.post("/chat") # Route: when a POST request hits "/chat", run chat() and return its dict as JSON
def chat(request: ChatRequest):
    # resume_text = read_pdf(Path("resume.pdf"))  # read the resume.pdf file
    # resume = parse_resume(resume_text)          # parse the resume text into a Resume object
    return StreamingResponse(
        ask_candidate(request.question, resume, request.history),
        media_type="text/plain",
        headers={"Cache-Control": "no-store","X-Accel-Buffering": "no"}
    )

