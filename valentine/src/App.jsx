import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const FLOATING_EMOJIS = ['💕', '💗', '💖', '💘', '💝', '🌷', '🪷', '🌸', '🩷', '💍']

const NO_MESSAGES = [
  'No',
  "We're literally engaged!",
  'Think again, future wifey!',
  'PLEASEEEEE 🥺',
  'Think again, future wifey!',
  "Nikki don't do this to me!",
  "I'll cancel the wedding! (jk I won't)",
  'I refuse to accept!',
  "I'll fill our house with tulips!",
  "You said yes to MARRIAGE but not this?!",
  'PLEASEEEEE 🥺',
]

const BEAR_MOODS = [
  { face: '🥰', label: 'hopeful' },
  { face: '😊', label: 'still-hopeful' },
  { face: '🥺', label: 'pleading' },
  { face: '😢', label: 'sad' },
  { face: '😭', label: 'crying' },
  { face: '💀', label: 'devastated' },
]

const QUIZ_QUESTIONS = [
  {
    question: "Where did we go on our first date?",
    options: ["Niloufer Cafe", "Manam Chocolate", "Telugu Medium", "Blue Tokai Coffee Roasters"],
    correct: 2, // Change this to the correct index
    reaction: { right: "You remember! 🥰", wrong: "Excuse me?! Did you forget the Brocolli Malai?! 😤" },
  },
  {
    question: "How many times have we said goodbye to each other before leaving by train?",
    options: ["9", "2", "6", "3"],
    correct: 3, // Change this to the correct index
    reaction: { right: "You remember so well! 😍", wrong: "You remeber to the Sarvowski bracelet but not this ?! 💀" },
  },
  {
    question: "What's the first thing I noticed about you?",
    options: ["Your smile", "Your eyes", "Your laugh", "Your caring nature"],
    correct: 0, // Change this to the correct index
    reaction: { right: "Still can't stop staring! 🥰", wrong: "How do you not know this, future wifey?! 💍😩" },
  },
  {
    question: "What car did we rent on Zoomcar when I came to Pune, but then it was sadly not available and we had to get a different car?",
    options: ["Tata Altroz", "Tata Nexon", "Maruti Vitara Brezza", "Suzuki Baleno"],
    correct: 1, // Change this to the correct index
    reaction: { right: "Wow !! Waah. What a memory 🎵💖", wrong: "OMG Nikki. You might be getting old! How could you forget 😭" },
  },
  {
    question: "What biscuit did we have for New Years 2026?",
    options: ["Parle G", "MariGold", "Osmania Biscuit", "Milano"],
    correct: 3, // Change this to the correct index
    reaction: { right: "Haha yep, that's the one! 😂💕", wrong: "Come on, try and remember the taste! 😅" },
  },
  
]

const FAIL_MESSAGES = [
  "Nikki... is that really you?! 🤔",
  "The wedding is DEFINITELY still on... but wow 😂",
]

// ── Sparkle cursor ──────────────────────────────────────────────
function SparkleCursor() {
  const canvasRef = useRef(null)
  const particles = useRef([])
  const mouse = useRef({ x: 0, y: 0 })
  const animRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    const handleResize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    const handleMove = (e) => {
      mouse.current.x = e.clientX
      mouse.current.y = e.clientY
      for (let i = 0; i < 2; i++) {
        particles.current.push({
          x: mouse.current.x + (Math.random() - 0.5) * 10,
          y: mouse.current.y + (Math.random() - 0.5) * 10,
          size: Math.random() * 3 + 1,
          speedX: (Math.random() - 0.5) * 1.5,
          speedY: (Math.random() - 0.5) * 1.5 - 1,
          life: 1,
          color: `hsl(${340 + Math.random() * 40}, 100%, ${60 + Math.random() * 30}%)`,
        })
      }
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      particles.current = particles.current.filter((p) => p.life > 0)
      for (const p of particles.current) {
        p.x += p.speedX
        p.y += p.speedY
        p.life -= 0.02
        p.size *= 0.98
        ctx.globalAlpha = p.life
        ctx.fillStyle = p.color
        ctx.beginPath()
        const spikes = 4
        const outerR = p.size
        const innerR = p.size * 0.4
        for (let i = 0; i < spikes * 2; i++) {
          const r = i % 2 === 0 ? outerR : innerR
          const angle = (i * Math.PI) / spikes - Math.PI / 2
          const x = p.x + Math.cos(angle) * r
          const y = p.y + Math.sin(angle) * r
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalAlpha = 1
      animRef.current = requestAnimationFrame(animate)
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('mousemove', handleMove)
    animate()

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('mousemove', handleMove)
      cancelAnimationFrame(animRef.current)
    }
  }, [])

  return <canvas ref={canvasRef} className="sparkle-canvas" />
}

// ── Floating emojis ─────────────────────────────────────────────
function FloatingHearts({ count = 20 }) {
  const [hearts, setHearts] = useState([])

  useEffect(() => {
    const initial = Array.from({ length: count }, (_, i) => ({
      id: i,
      emoji: FLOATING_EMOJIS[Math.floor(Math.random() * FLOATING_EMOJIS.length)],
      left: Math.random() * 100,
      size: 1 + Math.random() * 2,
      duration: 5 + Math.random() * 10,
      delay: Math.random() * 10,
    }))
    setHearts(initial)
  }, [count])

  return hearts.map((h) => (
    <span
      key={h.id}
      className="floating-heart"
      style={{
        left: `${h.left}%`,
        fontSize: `${h.size}rem`,
        animationDuration: `${h.duration}s`,
        animationDelay: `${h.delay}s`,
      }}
    >
      {h.emoji}
    </span>
  ))
}

// ── Fireworks canvas ────────────────────────────────────────────
function Fireworks() {
  const canvasRef = useRef(null)
  const animRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    const rockets = []
    const sparks = []

    const colors = [
      '#ff1744', '#ff4081', '#f50057', '#ff6f00',
      '#ffab00', '#ff80ab', '#ea80fc', '#e040fb',
      '#7c4dff', '#448aff', '#69f0ae', '#ffd740',
    ]

    function launchRocket() {
      rockets.push({
        x: Math.random() * canvas.width,
        y: canvas.height,
        targetY: canvas.height * 0.15 + Math.random() * canvas.height * 0.35,
        speed: 4 + Math.random() * 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        trail: [],
      })
    }

    function explode(rocket) {
      const count = 60 + Math.floor(Math.random() * 40)
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count
        const speed = 1 + Math.random() * 4
        sparks.push({
          x: rocket.x,
          y: rocket.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color: rocket.color,
          size: 1.5 + Math.random() * 2,
        })
      }
    }

    let lastLaunch = 0
    function animate(time) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      if (time - lastLaunch > 400 + Math.random() * 600) {
        launchRocket()
        lastLaunch = time
      }

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i]
        r.trail.push({ x: r.x, y: r.y })
        if (r.trail.length > 8) r.trail.shift()
        r.y -= r.speed

        for (let j = 0; j < r.trail.length; j++) {
          ctx.globalAlpha = j / r.trail.length * 0.5
          ctx.fillStyle = r.color
          ctx.beginPath()
          ctx.arc(r.trail[j].x, r.trail[j].y, 2, 0, Math.PI * 2)
          ctx.fill()
        }

        ctx.globalAlpha = 1
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(r.x, r.y, 2.5, 0, Math.PI * 2)
        ctx.fill()

        if (r.y <= r.targetY) {
          explode(r)
          rockets.splice(i, 1)
        }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]
        s.x += s.vx
        s.y += s.vy
        s.vy += 0.03
        s.vx *= 0.99
        s.life -= 0.012

        ctx.globalAlpha = Math.max(s.life, 0)
        ctx.fillStyle = s.color
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2)
        ctx.fill()

        ctx.globalAlpha = Math.max(s.life * 0.3, 0)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * s.life * 3, 0, Math.PI * 2)
        ctx.fill()

        if (s.life <= 0) sparks.splice(i, 1)
      }

      ctx.globalAlpha = 1
      animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)

    const handleResize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return <canvas ref={canvasRef} className="fireworks-canvas" />
}

// ── Typewriter ──────────────────────────────────────────────────
function Typewriter({ text, speed = 40, delay = 0, onDone }) {
  const [displayed, setDisplayed] = useState('')
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => setStarted(true), delay)
    return () => clearTimeout(timeout)
  }, [delay])

  useEffect(() => {
    if (!started) return
    if (displayed.length < text.length) {
      const timeout = setTimeout(() => {
        setDisplayed(text.slice(0, displayed.length + 1))
      }, speed)
      return () => clearTimeout(timeout)
    } else if (onDone) {
      onDone()
    }
  }, [displayed, text, speed, started, onDone])

  return <>{displayed}<span className="cursor-blink">|</span></>
}

// ── Confetti rain ───────────────────────────────────────────────
function ConfettiRain() {
  const pieces = Array.from({ length: 80 }, (_, i) => {
    const colors = ['#e91e63', '#ff5722', '#ff9800', '#ffeb3b', '#e040fb', '#7c4dff', '#00e5ff', '#69f0ae', '#ff80ab', '#ffd740']
    return {
      id: i,
      left: Math.random() * 100,
      color: colors[Math.floor(Math.random() * colors.length)],
      duration: 2 + Math.random() * 3,
      delay: Math.random() * 2,
      size: 5 + Math.random() * 10,
      shape: Math.random() > 0.5 ? '50%' : Math.random() > 0.5 ? '0' : '2px',
      wobble: Math.random() * 30 - 15,
    }
  })

  return pieces.map((p) => (
    <div
      key={p.id}
      className="confetti-piece"
      style={{
        left: `${p.left}%`,
        backgroundColor: p.color,
        width: `${p.size}px`,
        height: `${p.size * (Math.random() * 0.5 + 0.5)}px`,
        borderRadius: p.shape,
        animationDuration: `${p.duration}s`,
        animationDelay: `${p.delay}s`,
        '--wobble': `${p.wobble}px`,
      }}
    />
  ))
}

// ── Quiz component ──────────────────────────────────────────────
function Quiz({ onPass }) {
  const [currentQ, setCurrentQ] = useState(0)
  const [score, setScore] = useState(0)
  const [selected, setSelected] = useState(null)
  const [showReaction, setShowReaction] = useState(false)
  const [failed, setFailed] = useState(false)
  const [shaking, setShaking] = useState(false)

  const q = QUIZ_QUESTIONS[currentQ]
  const isCorrect = selected === q.correct
  const progress = ((currentQ) / QUIZ_QUESTIONS.length) * 100

  const handleSelect = (idx) => {
    if (showReaction) return
    setSelected(idx)
    setShowReaction(true)

    const correct = idx === q.correct
    if (correct) {
      setScore((s) => s + 1)
    } else {
      setShaking(true)
      setTimeout(() => setShaking(false), 500)
    }

    setTimeout(() => {
      if (currentQ < QUIZ_QUESTIONS.length - 1) {
        setCurrentQ((c) => c + 1)
        setSelected(null)
        setShowReaction(false)
      } else {
        // Quiz finished
        const finalScore = correct ? score + 1 : score
        if (finalScore === QUIZ_QUESTIONS.length) {
          onPass()
        } else {
          setFailed(true)
        }
      }
    }, 1500)
  }

  const handleRetake = () => {
    setCurrentQ(0)
    setScore(0)
    setSelected(null)
    setShowReaction(false)
    setFailed(false)
  }

  if (failed) {
    const wrongCount = QUIZ_QUESTIONS.length - score
    return (
      <div className="valentine-container">
        <SparkleCursor />
        <FloatingHearts count={10} />
        <div className="content quiz-fail">
          <div className="fail-emoji">😤</div>
          <h1 className="fail-title">Identity Verification Failed!</h1>
          <p className="fail-score">You got {score}/{QUIZ_QUESTIONS.length} right</p>
          <div className="fail-messages">
            {FAIL_MESSAGES.slice(0, Math.min(wrongCount + 1, FAIL_MESSAGES.length)).map((msg, i) => (
              <p key={i} className="fail-message" style={{ animationDelay: `${i * 0.3}s` }}>{msg}</p>
            ))}
          </div>
          <button className="btn-retake" onClick={handleRetake}>
            Fine, let me try again 😅
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`valentine-container ${shaking ? 'shake' : ''}`}>
      <SparkleCursor />
      <FloatingHearts count={10} />
      <div className="content quiz-content">
        <div className="quiz-header">
          <div className="quiz-icon">🔐</div>
          <h2 className="quiz-title">Identity Verification</h2>
          <p className="quiz-subtitle">
            This message is only for Nikki. Prove it's you!
          </p>
        </div>

        <div className="quiz-progress-bar">
          <div className="quiz-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <p className="quiz-counter">Question {currentQ + 1} of {QUIZ_QUESTIONS.length}</p>

        <div className="quiz-question-card">
          <h3 className="quiz-question">{q.question}</h3>
          <div className="quiz-options">
            {q.options.map((opt, idx) => {
              let cls = 'quiz-option'
              if (showReaction) {
                if (idx === q.correct) cls += ' correct'
                else if (idx === selected && !isCorrect) cls += ' wrong'
              }
              if (idx === selected) cls += ' selected'
              return (
                <button
                  key={idx}
                  className={cls}
                  onClick={() => handleSelect(idx)}
                  disabled={showReaction}
                >
                  {opt}
                </button>
              )
            })}
          </div>
        </div>

        {showReaction && (
          <p className={`quiz-reaction ${isCorrect ? 'correct' : 'wrong'}`}>
            {isCorrect ? q.reaction.right : q.reaction.wrong}
          </p>
        )}

        <div className="quiz-score-dots">
          {QUIZ_QUESTIONS.map((_, i) => (
            <span
              key={i}
              className={`score-dot ${
                i < currentQ ? 'answered' :
                i === currentQ && showReaction ? (isCorrect ? 'correct' : 'wrong') :
                ''
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main App ────────────────────────────────────────────────────
function App() {
  const [stage, setStage] = useState('envelope') // envelope | quiz | question | celebration
  const [noCount, setNoCount] = useState(0)
  const [shaking, setShaking] = useState(false)
  const [envelopeOpen, setEnvelopeOpen] = useState(false)
  const [typeLine, setTypeLine] = useState(0)
  const noBtnRef = useRef(null)
  const containerRef = useRef(null)

  const yesScale = 1 + noCount * 0.2
  const noText = NO_MESSAGES[Math.min(noCount, NO_MESSAGES.length - 1)]
  const bearMood = BEAR_MOODS[Math.min(noCount, BEAR_MOODS.length - 1)]

  const handleOpenEnvelope = useCallback(() => {
    setEnvelopeOpen(true)
    setTimeout(() => setStage('quiz'), 800)
  }, [])

  const handleQuizPass = useCallback(() => {
    setStage('question')
  }, [])

  const handleNo = useCallback(() => {
    setNoCount((c) => c + 1)
    setShaking(true)
    setTimeout(() => setShaking(false), 500)
  }, [])

  const handleYes = useCallback(() => {
    setStage('celebration')
  }, [])

  // No button runs away from mouse
  const handleNoMouseEnter = useCallback(() => {
    if (noCount < 2) return
    const btn = noBtnRef.current
    if (!btn) return
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()

    const maxX = rect.width - btnRect.width - 20
    const maxY = rect.height - btnRect.height - 20
    const newX = Math.random() * maxX
    const newY = Math.random() * maxY

    btn.style.position = 'fixed'
    btn.style.left = `${rect.left + newX}px`
    btn.style.top = `${rect.top + newY}px`
    btn.style.zIndex = '100'
  }, [noCount])

  // ── Envelope stage ──────────────────────────────────────────
  if (stage === 'envelope') {
    return (
      <div className="valentine-container" ref={containerRef}>
        <SparkleCursor />
        <FloatingHearts count={12} />
        <div className="content">
          <div className="flower-row">
            <span className="flower-sway" style={{ animationDelay: '0s' }}>🌷</span>
            <span className="flower-sway" style={{ animationDelay: '0.3s' }}>🪷</span>
            <span className="flower-sway" style={{ animationDelay: '0.6s' }}>🌷</span>
          </div>
          <div
            className={`envelope-wrapper ${envelopeOpen ? 'opening' : ''}`}
            onClick={handleOpenEnvelope}
          >
            <div className="envelope-icon">💌</div>
            <p className="tap-text">tap to open</p>
          </div>
          <p className="intro-text">Hey Nikki, your future husband has something to ask... 💍</p>
        </div>
      </div>
    )
  }

  // ── Quiz stage ────────────────────────────────────────────────
  if (stage === 'quiz') {
    return <Quiz onPass={handleQuizPass} />
  }

  // ── Celebration stage ───────────────────────────────────────
  if (stage === 'celebration') {
    return (
      <div className="valentine-container celebration-bg" ref={containerRef}>
        <Fireworks />
        <ConfettiRain />
        <div className="celebration">
          <div className="celebration-emoji">💍</div>
          <h1 className="celebration-title">She said yes... again!!</h1>
          <div className="celebration-message">
            <Typewriter
              text="Nikki, you already agreed to marry me..."
              speed={35}
              delay={500}
              onDone={() => setTypeLine(1)}
            />
            {typeLine >= 1 && (
              <>
                <br /><br />
                <Typewriter
                  text="...but being your Valentine still makes my heart race just the same."
                  speed={30}
                  delay={300}
                  onDone={() => setTypeLine(2)}
                />
              </>
            )}
            {typeLine >= 2 && (
              <>
                <br /><br />
                <Typewriter
                  text="Every day with you feels like a garden full of lilies and tulips in bloom. Your deeply caring heart is my favorite place in the world."
                  speed={25}
                  delay={300}
                  onDone={() => setTypeLine(3)}
                />
              </>
            )}
            {typeLine >= 3 && (
              <>
                <br /><br />
                <Typewriter
                  text="Can't wait to spend every Valentine's Day with you, forever. Happy Valentine's Day, my future wifey. 💖"
                  speed={30}
                  delay={300}
                />
              </>
            )}
          </div>
          <div className="celebration-flowers-row">
            <span className="heart-bounce" style={{ animationDelay: '0s' }}>🌷</span>
            <span className="heart-bounce" style={{ animationDelay: '0.1s' }}>💖</span>
            <span className="heart-bounce" style={{ animationDelay: '0.2s' }}>🪷</span>
            <span className="heart-bounce" style={{ animationDelay: '0.3s' }}>💍</span>
            <span className="heart-bounce" style={{ animationDelay: '0.4s' }}>🪷</span>
            <span className="heart-bounce" style={{ animationDelay: '0.5s' }}>💖</span>
            <span className="heart-bounce" style={{ animationDelay: '0.6s' }}>🌷</span>
          </div>
        </div>
      </div>
    )
  }

  // ── Question stage ──────────────────────────────────────────
  return (
    <div
      className={`valentine-container ${shaking ? 'shake' : ''}`}
      ref={containerRef}
    >
      <SparkleCursor />
      <FloatingHearts count={20} />
      <div className="content">
        <div className={`bear-face ${bearMood.label}`}>
          <span className="bear-emoji">{bearMood.face}</span>
        </div>
        <h1 className="question">Kasireddy Nikita, will you be my Valentine?</h1>
        <p className="sub-text">
          {noCount === 0
            ? "I know you already said yes to forever, but..."
            : noCount < 3
              ? "Come on future Mrs., you know you want to say yes..."
              : noCount < 6
                ? "You agreed to MARRY me but won't be my Valentine?!"
                : noCount < 9
                  ? "I WILL keep asking forever... which I can, because we're getting married! 🥺"
                  : "Nikki please, I'll fill our entire wedding venue with tulips! 🌷💍"}
        </p>
        <div className="buttons">
          <button
            className="btn-yes"
            onClick={handleYes}
            style={{
              transform: `scale(${yesScale})`,
              fontSize: `${1.2 + noCount * 0.1}rem`,
            }}
          >
            {noCount < 3 ? 'Yes! 💖' : noCount < 6 ? 'YES PLEASE! 🌷' : 'OBVIOUSLY YES!! 💍💖🌷'}
          </button>
          <button
            ref={noBtnRef}
            className="btn-no"
            onClick={handleNo}
            onMouseEnter={handleNoMouseEnter}
            style={{
              fontSize: `${Math.max(1 - noCount * 0.06, 0.6)}rem`,
            }}
          >
            {noText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
