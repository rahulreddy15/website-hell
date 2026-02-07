import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const HEARTS = ['💕', '💗', '💖', '💘', '💝', '❤️', '🩷', '🌸']

const NO_MESSAGES = [
  'No',
  'Are you sure?',
  'Really sure?',
  'Think again!',
  'Last chance!',
  'Surely not?',
  'You might regret this!',
  'Give it another thought!',
  'Are you being serious?',
  'This is not a joke!',
  'PLEASEEE',
]

function FloatingHearts() {
  const [hearts, setHearts] = useState([])

  useEffect(() => {
    const initial = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      emoji: HEARTS[Math.floor(Math.random() * HEARTS.length)],
      left: Math.random() * 100,
      size: 1.2 + Math.random() * 1.8,
      duration: 6 + Math.random() * 8,
      delay: Math.random() * 8,
    }))
    setHearts(initial)
  }, [])

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

function Confetti() {
  const pieces = Array.from({ length: 50 }, (_, i) => {
    const colors = ['#e91e63', '#ff5722', '#ff9800', '#ffeb3b', '#e040fb', '#7c4dff', '#00e5ff', '#69f0ae']
    return {
      id: i,
      left: Math.random() * 100,
      color: colors[Math.floor(Math.random() * colors.length)],
      duration: 1.5 + Math.random() * 2,
      delay: Math.random() * 0.8,
      size: 6 + Math.random() * 8,
      shape: Math.random() > 0.5 ? '50%' : '0',
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
        height: `${p.size}px`,
        borderRadius: p.shape,
        animationDuration: `${p.duration}s`,
        animationDelay: `${p.delay}s`,
      }}
    />
  ))
}

function App() {
  const [noCount, setNoCount] = useState(0)
  const [accepted, setAccepted] = useState(false)
  const noBtnRef = useRef(null)

  const yesScale = 1 + noCount * 0.15
  const noText = NO_MESSAGES[Math.min(noCount, NO_MESSAGES.length - 1)]

  const handleNo = useCallback(() => {
    setNoCount((c) => c + 1)
  }, [])

  const handleYes = useCallback(() => {
    setAccepted(true)
  }, [])

  // Make No button shrink progressively
  const noScale = Math.max(1 - noCount * 0.1, 0.4)

  if (accepted) {
    return (
      <div className="valentine-container">
        <FloatingHearts />
        <Confetti />
        <div className="celebration">
          <div className="celebration-emoji">💕</div>
          <h1 className="celebration-title">Yaaaay!!</h1>
          <p className="celebration-message">
            You just made me the happiest person in the world.
            <br />
            Happy Valentine's Day, my love.
            <br />
            I can't wait to celebrate with you.
          </p>
          <div className="celebration-heart">💖</div>
        </div>
      </div>
    )
  }

  return (
    <div className="valentine-container">
      <FloatingHearts />
      <div className="content">
        <div className="envelope">💌</div>
        <h1 className="question">Will you be my Valentine?</h1>
        <p className="sub-text">
          {noCount === 0
            ? 'I have a very important question for you...'
            : noCount < 4
              ? "Come on, you know you want to say yes..."
              : "I'm not giving up that easily!"}
        </p>
        <div className="buttons">
          <button
            className="btn-yes"
            onClick={handleYes}
            style={{
              transform: `scale(${yesScale})`,
              padding: `${0.9 + noCount * 0.1}rem ${2.5 + noCount * 0.3}rem`,
              fontSize: `${1.2 + noCount * 0.08}rem`,
            }}
          >
            Yes! 💖
          </button>
          <button
            ref={noBtnRef}
            className="btn-no"
            onClick={handleNo}
            style={{
              transform: `scale(${noScale})`,
              opacity: noScale,
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
