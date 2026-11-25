from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_feature, P, Principal, require_perm
from app.core.db import get_db
from app.schemas.inventory import RecipeDraftIn, RecipeDraftsOut
from app.services import audit, recipe_ai

router = APIRouter(tags=["recipes"], dependencies=[Depends(require_feature("ai"))])


@router.post("/recipes/ai-draft", response_model=RecipeDraftsOut)
def ai_draft(data: RecipeDraftIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db),
             model: recipe_ai.RecipeModel = Depends(recipe_ai.get_recipe_model)):
    """Suggests (never saves) what one portion of each dish uses, from the restaurant's own stock list. Owner / manager.
    Up to 10 dishes per call; the client batches. Anything the model names that is not a stock item of this restaurant is
    dropped or returned in `missing` (a new stock item to create)."""
    recipe_ai.rate_limit(p.user_id)
    out = recipe_ai.draft(db, p, model, data.menu_item_ids)
    audit.record(db, p, "recipe.ai_draft", "recipe", None, {"dishes": len(data.menu_item_ids)})
    db.commit()
    return out
