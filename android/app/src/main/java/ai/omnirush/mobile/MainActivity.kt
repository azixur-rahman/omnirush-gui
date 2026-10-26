package ai.omnirush.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val Ink = Color(0xFFF5F4FA)
private val MutedInk = Color(0xFF9A98A8)
private val Canvas = Color(0xFF0B0B0D)
private val Glass = Color(0xFF17171C).copy(alpha = 0.84f)
private val GlassLight = Color(0xFF202027).copy(alpha = 0.82f)
private val Accent = Color(0xFFA99BFF)
private val AccentDeep = Color(0xFF7566E8)
private val Divider = Color.White.copy(alpha = 0.08f)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            OmniRushTheme {
                OmniRushChat()
            }
        }
    }
}

private enum class MessageRole {
    User,
    Assistant,
}

private data class ChatMessage(
    val id: Long,
    val role: MessageRole,
    val text: String,
)

@Composable
private fun OmniRushChat() {
    val messages = remember { mutableStateListOf<ChatMessage>() }
    var draft by rememberSaveable { mutableStateOf("") }
    var isThinking by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current

    fun sendMessage(value: String) {
        val prompt = value.trim()
        if (prompt.isEmpty() || isThinking) return

        messages += ChatMessage(System.nanoTime(), MessageRole.User, prompt)
        draft = ""
        keyboard?.hide()
        isThinking = true

        scope.launch {
            delay(620)
            messages += ChatMessage(
                System.nanoTime(),
                MessageRole.Assistant,
                demoReply(prompt),
            )
            isThinking = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        TopBar()

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            if (messages.isEmpty()) {
                WelcomeContent(onPrompt = ::sendMessage)
            } else {
                Conversation(messages = messages, isThinking = isThinking)
            }
        }

        Composer(
            value = draft,
            enabled = !isThinking,
            onValueChange = { draft = it },
            onSend = { sendMessage(draft) },
        )
    }
}

@Composable
private fun TopBar() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassIconButton(icon = Icons.Outlined.Menu, label = "Open menu", onClick = {})

        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "OmniRush",
                    color = Ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.2).sp,
                )
                Spacer(Modifier.width(6.dp))
                Icon(
                    imageVector = Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    tint = Accent,
                    modifier = Modifier.size(15.dp),
                )
            }
            Text(
                text = "GPT-6 Astra  •  Ready",
                color = MutedInk,
                fontSize = 11.sp,
                letterSpacing = 0.1.sp,
            )
        }

        GlassIconButton(icon = Icons.Outlined.Tune, label = "Open settings", onClick = {})
    }
}

@Composable
private fun WelcomeContent(onPrompt: (String) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 22.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AnimatedVisibility(
            visible = true,
            enter = fadeIn(tween(260)) + scaleIn(
                initialScale = 0.94f,
                animationSpec = spring(
                    dampingRatio = Spring.DampingRatioNoBouncy,
                    stiffness = Spring.StiffnessMediumLow,
                ),
            ),
        ) {
            Box(
                modifier = Modifier
                    .size(76.dp)
                    .background(
                        brush = Brush.radialGradient(
                            colors = listOf(Accent.copy(alpha = 0.72f), AccentDeep.copy(alpha = 0.28f)),
                        ),
                        shape = CircleShape,
                    )
                    .padding(18.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    tint = Ink,
                    modifier = Modifier.size(34.dp),
                )
            }
        }

        Spacer(Modifier.height(22.dp))
        Text(
            text = "What can I help you make?",
            color = Ink,
            fontSize = 25.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.65).sp,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Ask anything, explore an idea, or start building.",
            color = MutedInk,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SuggestionCard(
                icon = Icons.Outlined.AutoAwesome,
                title = "Design a beautiful mobile interface",
                subtitle = "Start with a clear, polished direction",
                onClick = { onPrompt("Design a beautiful mobile interface") },
            )
            SuggestionCard(
                icon = Icons.Outlined.WbSunny,
                title = "Give me a fresh idea",
                subtitle = "Turn a blank page into a first step",
                onClick = { onPrompt("Give me a fresh idea") },
            )
        }

        Spacer(Modifier.height(22.dp))
        Text(
            text = "OmniRush can make mistakes. Check important information.",
            color = MutedInk.copy(alpha = 0.72f),
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SuggestionCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    GlassSurface(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 70.dp)
            .clickable(onClick = onClick),
        color = Glass,
        shape = RoundedCornerShape(20.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .background(Accent.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = Accent, modifier = Modifier.size(19.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(3.dp))
                Text(subtitle, color = MutedInk, fontSize = 12.sp)
            }
            Icon(Icons.Outlined.ArrowUpward, contentDescription = null, tint = MutedInk, modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
private fun Conversation(messages: List<ChatMessage>, isThinking: Boolean) {
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size, isThinking) {
        val itemCount = messages.size + if (isThinking) 1 else 0
        if (itemCount > 0) listState.animateScrollToItem(itemCount - 1)
    }

    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp),
        contentPadding = PaddingValues(top = 10.dp, bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        items(messages, key = { it.id }) { message ->
            MessageRow(message)
        }
        if (isThinking) {
            item(key = "thinking") { ThinkingRow() }
        }
    }
}

@Composable
private fun MessageRow(message: ChatMessage) {
    val clipboard = LocalClipboardManager.current
    val isUser = message.role == MessageRole.User

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!isUser) {
            AssistantMark()
            Spacer(Modifier.width(10.dp))
        }

        Column(
            modifier = Modifier
                .fillMaxWidth(if (isUser) 0.86f else 1f)
                .animateContentSize(animationSpec = tween(220, easing = FastOutSlowInEasing)),
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        ) {
            GlassSurface(
                color = if (isUser) GlassLight else Color.Transparent,
                shape = RoundedCornerShape(
                    topStart = 20.dp,
                    topEnd = 20.dp,
                    bottomStart = if (isUser) 20.dp else 6.dp,
                    bottomEnd = if (isUser) 6.dp else 20.dp,
                ),
            ) {
                Text(
                    text = message.text,
                    color = Ink,
                    fontSize = 15.sp,
                    lineHeight = 23.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 13.dp),
                )
            }

            if (!isUser) {
                Row(
                    modifier = Modifier.padding(top = 5.dp, start = 3.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    SmallAction(icon = Icons.Outlined.ContentCopy, label = "Copy response") {
                        clipboard.setText(AnnotatedString(message.text))
                    }
                    SmallAction(icon = Icons.Outlined.Refresh, label = "Regenerate response", onClick = {})
                    SmallAction(icon = Icons.Outlined.MoreHoriz, label = "More response actions", onClick = {})
                }
            }
        }
    }
}

@Composable
private fun ThinkingRow() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AssistantMark()
        Spacer(Modifier.width(10.dp))
        Text("Thinking…", color = MutedInk, fontSize = 14.sp)
    }
}

@Composable
private fun AssistantMark() {
    Box(
        modifier = Modifier
            .size(28.dp)
            .background(
                Brush.linearGradient(listOf(Accent, AccentDeep)),
                CircleShape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.AutoAwesome,
            contentDescription = "OmniRush",
            tint = Color.White,
            modifier = Modifier.size(15.dp),
        )
    }
}

@Composable
private fun Composer(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val canSend = value.trim().isNotEmpty() && enabled
    GlassSurface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .windowInsetsPadding(WindowInsets.ime)
            .padding(bottom = 8.dp),
        color = GlassLight,
        shape = RoundedCornerShape(25.dp),
    ) {
        Row(
            modifier = Modifier.padding(start = 6.dp, end = 7.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            GlassIconButton(icon = Icons.Outlined.Add, label = "Add attachment", onClick = {})

            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp, vertical = 10.dp),
                enabled = enabled,
                textStyle = TextStyle(color = Ink, fontSize = 16.sp, lineHeight = 22.sp),
                cursorBrush = SolidColor(Accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                maxLines = 6,
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isEmpty()) {
                            Text("Message OmniRush…", color = MutedInk, fontSize = 16.sp)
                        }
                        innerTextField()
                    }
                },
            )

            if (value.isBlank()) {
                GlassIconButton(icon = Icons.Outlined.MicNone, label = "Voice input", onClick = {})
            }
            SendButton(enabled = canSend, onClick = onSend)
        }
    }
}

@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.92f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioNoBouncy),
        label = "send-button-press",
    )

    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interactionSource,
        modifier = Modifier
            .size(42.dp)
            .scale(scale)
            .background(if (enabled) Accent else Color.White.copy(alpha = 0.08f), CircleShape),
    ) {
        Icon(
            imageVector = Icons.Outlined.ArrowUpward,
            contentDescription = "Send message",
            tint = if (enabled) Canvas else MutedInk,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun SmallAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(34.dp)) {
        Icon(icon, contentDescription = label, tint = MutedInk, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun GlassIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(42.dp)) {
        Icon(icon, contentDescription = label, tint = MutedInk, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun GlassSurface(
    modifier: Modifier = Modifier,
    color: Color,
    shape: RoundedCornerShape,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        color = color,
        shape = shape,
        border = BorderStroke(1.dp, Divider),
        shadowElevation = 10.dp,
        tonalElevation = 0.dp,
        content = content,
    )
}

private fun demoReply(prompt: String): String {
    return when {
        prompt.contains("interface", ignoreCase = true) || prompt.contains("ui", ignoreCase = true) ->
            "A strong direction is to keep the conversation content-first: one calm surface, clear hierarchy, and motion only when it explains a change. The glass composer below is designed to stay close to your thumb."
        prompt.contains("idea", ignoreCase = true) ->
            "Try this: a quiet daily studio where every chat becomes a small, focused project. Start with one sentence, then let OmniRush turn it into the next three useful steps."
        else ->
            "I’m ready. Keep going with your thought and I’ll help shape it into something clear and useful."
    }
}

@Composable
private fun OmniRushTheme(content: @Composable () -> Unit) {
    val colors = darkColorScheme(
        background = Canvas,
        surface = Glass,
        surfaceVariant = GlassLight,
        primary = Accent,
        onPrimary = Canvas,
        onBackground = Ink,
        onSurface = Ink,
        onSurfaceVariant = MutedInk,
    )

    MaterialTheme(colorScheme = colors) {
        ProvideTextStyle(
            value = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            content = content,
        )
    }
}
